use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::{Row, RowAccessor, RowFormatter};
use serde::Serialize;
use sqlparser::ast::{
    BinaryOperator, Distinct, Expr, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr,
    LimitClause, OrderByKind, SelectItem, SetExpr, Statement, TableFactor, UnaryOperator, Value,
};
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs::File;
use std::path::Path;

const MAX_SOURCE_ROWS: usize = 100_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub total_rows: usize,
    pub truncated: bool,
}

struct Table {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
}

struct Query {
    projection: Vec<Projection>,
    filter: Option<Expr>,
    order: Vec<SortOrder>,
    distinct: bool,
    limit: Option<usize>,
    offset: usize,
}

enum Projection {
    All,
    Expression {
        expression: Expr,
        name: String,
    },
    Count {
        expression: Option<Expr>,
        name: String,
    },
}

struct SortOrder {
    expression: Expr,
    descending: bool,
    nulls_first: bool,
}

/// Reads a CSV, TSV, or Parquet file and evaluates a read-only SQL query.
/// The query parser supplies the syntax tree, while this module validates and
/// executes the supported query operations against the in-memory table.
pub fn query_file(
    path: &Path,
    logical_path: &str,
    query: &str,
    page: usize,
    page_size: Option<usize>,
) -> Result<DataQueryResult, String> {
    let statements = Parser::parse_sql(&DuckDbDialect {}, query).map_err(|err| err.to_string())?;
    let statement = statements
        .first()
        .filter(|_| statements.len() == 1)
        .ok_or_else(|| "Only one read-only SELECT query is supported".to_string())?;
    let sql_query = match statement {
        Statement::Query(query) => query,
        _ => return Err("Only one read-only SELECT query is supported".to_string()),
    };

    let mut table = read_table(path, logical_path)?;
    let parsed = parse_query(sql_query, &table.columns)?;
    let source_truncated = table.truncated;
    let mut rows = table.rows.drain(..).collect::<Vec<_>>();
    if let Some(filter) = &parsed.filter {
        let mut filtered_rows = Vec::with_capacity(rows.len());
        for row in rows {
            if eval_predicate(filter, &row, &table.columns)? == Some(true) {
                filtered_rows.push(row);
            }
        }
        rows = filtered_rows;
    }

    let mut ordered_rows = rows
        .into_iter()
        .map(|row| {
            let keys = parsed
                .order
                .iter()
                .map(|order| eval_value(&order.expression, &row, &table.columns))
                .collect::<Result<Vec<_>, _>>();
            keys.map(|keys| (row, keys))
        })
        .collect::<Result<Vec<_>, _>>()?;
    ordered_rows.sort_by(|(_, left_keys), (_, right_keys)| {
        for (index, order) in parsed.order.iter().enumerate() {
            let left = left_keys[index].as_ref();
            let right = right_keys[index].as_ref();
            let mut comparison = compare_order_values(left, right, order.nulls_first);
            if order.descending && left.is_some() && right.is_some() {
                comparison = comparison.reverse();
            }
            if comparison != Ordering::Equal {
                return comparison;
            }
        }
        Ordering::Equal
    });

    if let [Projection::Count { expression, name }] = parsed.projection.as_slice() {
        let count = ordered_rows
            .iter()
            .filter(|(row, _)| {
                expression.as_ref().is_none_or(|expression| {
                    eval_value(expression, row, &table.columns)
                        .map(|value| value.is_some())
                        .unwrap_or(false)
                })
            })
            .count();
        return Ok(DataQueryResult {
            columns: vec![name.clone()],
            rows: vec![vec![Some(count.to_string())]],
            total_rows: 1,
            truncated: source_truncated,
        });
    }

    let columns = parsed
        .projection
        .iter()
        .flat_map(|projection| match projection {
            Projection::All => table.columns.clone(),
            Projection::Expression { name, .. } | Projection::Count { name, .. } => {
                vec![name.clone()]
            }
        })
        .collect::<Vec<_>>();
    let mut projected_rows = Vec::with_capacity(ordered_rows.len());
    for (row, _) in &ordered_rows {
        let mut projected_row = Vec::new();
        for projection in &parsed.projection {
            match projection {
                Projection::All => projected_row.extend(row.clone()),
                Projection::Expression { expression, .. } => {
                    projected_row.push(eval_value(expression, row, &table.columns)?);
                }
                Projection::Count { .. } => unreachable!("count is handled above"),
            }
        }
        projected_rows.push(projected_row);
    }

    if parsed.distinct {
        let mut seen = HashSet::with_capacity(projected_rows.len());
        projected_rows.retain(|row| seen.insert(row.clone()));
    }
    if let Some(limit) = parsed.limit {
        projected_rows = projected_rows
            .into_iter()
            .skip(parsed.offset)
            .take(limit)
            .collect();
    } else if parsed.offset > 0 {
        projected_rows = projected_rows.into_iter().skip(parsed.offset).collect();
    }

    let total_rows = projected_rows.len();
    let start = page_size
        .map(|size| page.saturating_mul(size).min(total_rows))
        .unwrap_or(0);
    let rows_to_return = match page_size {
        Some(size) => projected_rows.into_iter().skip(start).take(size).collect(),
        None => projected_rows,
    };
    Ok(DataQueryResult {
        columns,
        rows: rows_to_return,
        total_rows,
        truncated: source_truncated,
    })
}

fn read_table(path: &Path, logical_path: &str) -> Result<Table, String> {
    match Path::new(logical_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "parquet" => read_parquet(path),
        "csv" => read_csv(path, b','),
        "tsv" => read_csv(path, b'\t'),
        _ => Err("Only CSV, TSV, and Parquet files are supported".to_string()),
    }
}

fn read_csv(path: &Path, delimiter: u8) -> Result<Table, String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .from_path(path)
        .map_err(|err| err.to_string())?;
    let columns = reader
        .headers()
        .map_err(|err| err.to_string())?
        .iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    let mut truncated = false;
    for record in reader.records() {
        if rows.len() >= MAX_SOURCE_ROWS {
            truncated = true;
            break;
        }
        let record = record.map_err(|err| err.to_string())?;
        rows.push(
            (0..columns.len())
                .map(|index| record.get(index).map(str::to_string))
                .collect(),
        );
    }
    Ok(Table {
        columns,
        rows,
        truncated,
    })
}

fn read_parquet(path: &Path) -> Result<Table, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let reader = SerializedFileReader::new(file).map_err(|err| err.to_string())?;
    let fallback_columns = reader
        .metadata()
        .file_metadata()
        .schema_descr()
        .columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect::<Vec<_>>();
    let mut row_iter = reader.get_row_iter(None).map_err(|err| err.to_string())?;
    let Some(first) = row_iter.next().transpose().map_err(|err| err.to_string())? else {
        return Ok(Table {
            columns: fallback_columns,
            rows: Vec::new(),
            truncated: false,
        });
    };
    let columns = first
        .get_column_iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let mut rows = vec![row_to_values(&first)];
    let mut truncated = false;
    for row in row_iter {
        if rows.len() >= MAX_SOURCE_ROWS {
            truncated = true;
            break;
        }
        rows.push(row_to_values(&row.map_err(|err| err.to_string())?));
    }
    Ok(Table {
        columns,
        rows,
        truncated,
    })
}

fn row_to_values(row: &Row) -> Vec<Option<String>> {
    row.get_column_iter()
        .enumerate()
        .map(|(index, (_, _field))| {
            if row.is_null(index).unwrap_or(false) {
                None
            } else {
                Some(format!("{}", row.fmt(index)))
            }
        })
        .collect()
}

fn parse_query(sql_query: &sqlparser::ast::Query, columns: &[String]) -> Result<Query, String> {
    if sql_query.with.is_some()
        || sql_query.fetch.is_some()
        || !sql_query.locks.is_empty()
        || sql_query.for_clause.is_some()
        || sql_query.settings.is_some()
        || sql_query.format_clause.is_some()
        || !sql_query.pipe_operators.is_empty()
    {
        return Err("Only a single SELECT from data is supported".to_string());
    }

    let select = match sql_query.body.as_ref() {
        SetExpr::Select(select) => select,
        _ => return Err("Only a single SELECT from data is supported".to_string()),
    };
    if select.from.len() != 1
        || !select.from[0].joins.is_empty()
        || select.prewhere.is_some()
        || !select.lateral_views.is_empty()
        || !select.connect_by.is_empty()
        || !select.cluster_by.is_empty()
        || !select.distribute_by.is_empty()
        || !select.sort_by.is_empty()
        || select.having.is_some()
        || !select.named_window.is_empty()
        || select.qualify.is_some()
        || select.exclude.is_some()
        || select.into.is_some()
        || select.top.is_some()
        || select.select_modifiers.is_some()
        || select.value_table_mode.is_some()
    {
        return Err("Only a single SELECT from data is supported".to_string());
    }
    if !matches!(&select.group_by, GroupByExpr::Expressions(expressions, modifiers) if expressions.is_empty() && modifiers.is_empty())
    {
        return Err("GROUP BY is not supported".to_string());
    }
    match &select.from[0].relation {
        TableFactor::Table {
            name,
            alias: _alias,
            args: None,
            with_hints,
            version: None,
            with_ordinality: false,
            partitions,
            json_path: None,
            sample: None,
            index_hints,
        } if with_hints.is_empty() && partitions.is_empty() && index_hints.is_empty() => {
            let table_name = name
                .0
                .last()
                .and_then(|part| part.as_ident())
                .map(|ident| ident.value.as_str())
                .unwrap_or_default();
            if !table_name.eq_ignore_ascii_case("data") {
                return Err("The query source must be data".to_string());
            }
        }
        _ => return Err("The query source must be data".to_string()),
    };

    let distinct = match &select.distinct {
        None | Some(Distinct::All) => false,
        Some(Distinct::Distinct) => true,
        Some(Distinct::On(_)) => return Err("DISTINCT ON is not supported".to_string()),
    };
    let projection = select
        .projection
        .iter()
        .map(|item| parse_projection(item, columns))
        .collect::<Result<Vec<_>, _>>()?;
    if projection.is_empty()
        || projection
            .iter()
            .filter(|projection| matches!(projection, Projection::Count { .. }))
            .count()
            > 0
            && projection.len() != 1
    {
        return Err("COUNT must be the only selected expression".to_string());
    }
    if let Some(filter) = &select.selection {
        validate_expression(filter, columns)?;
    }

    let order = match &sql_query.order_by {
        None => Vec::new(),
        Some(order_by) => match &order_by.kind {
            OrderByKind::Expressions(expressions) if order_by.interpolate.is_none() => expressions
                .iter()
                .map(|order| {
                    if order.with_fill.is_some() {
                        return Err("ORDER BY WITH FILL is not supported".to_string());
                    }
                    Ok(SortOrder {
                        expression: order.expr.clone(),
                        descending: order.options.asc == Some(false),
                        nulls_first: order.options.nulls_first.unwrap_or(false),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
            _ => return Err("Only ORDER BY expressions are supported".to_string()),
        },
    };
    for order in &order {
        validate_expression(&order.expression, columns)?;
    }
    let (limit, offset) = parse_limit(sql_query.limit_clause.as_ref())?;
    Ok(Query {
        projection,
        filter: select.selection.clone(),
        order,
        distinct,
        limit,
        offset,
    })
}

fn parse_projection(item: &SelectItem, columns: &[String]) -> Result<Projection, String> {
    let (expression, alias) = match item {
        SelectItem::Wildcard(options) if options == &Default::default() => {
            return Ok(Projection::All)
        }
        SelectItem::QualifiedWildcard(_, options) if options == &Default::default() => {
            return Err("Qualified wildcards are not supported".to_string())
        }
        SelectItem::UnnamedExpr(expression) => (expression, None),
        SelectItem::ExprWithAlias { expr, alias } => (expr, Some(alias.value.clone())),
        SelectItem::ExprWithAliases { .. } => {
            return Err("Multiple expression aliases are not supported".to_string())
        }
        SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => {
            return Err("Wildcard options are not supported".to_string())
        }
    };
    if let Some(count_expression) = count_expression(expression)? {
        if let Some(count_expression) = &count_expression {
            validate_expression(count_expression, columns)?;
        }
        return Ok(Projection::Count {
            expression: count_expression,
            name: alias.unwrap_or_else(|| "count".to_string()),
        });
    }
    let name = alias.unwrap_or_else(|| match expression {
        Expr::Identifier(identifier) => identifier.value.clone(),
        Expr::CompoundIdentifier(identifiers) => identifiers
            .last()
            .map(|identifier| identifier.value.clone())
            .unwrap_or_else(|| expression.to_string()),
        _ => expression.to_string(),
    });
    validate_expression(expression, columns)?;
    Ok(Projection::Expression {
        expression: expression.clone(),
        name,
    })
}

fn count_expression(expression: &Expr) -> Result<Option<Option<Expr>>, String> {
    let Expr::Function(function) = expression else {
        return Ok(None);
    };
    let name = function
        .name
        .0
        .last()
        .and_then(|part| part.as_ident())
        .map(|ident| ident.value.as_str())
        .unwrap_or_default();
    if !name.eq_ignore_ascii_case("count") {
        return Err(format!("Unsupported function '{name}'"));
    }
    let FunctionArguments::List(arguments) = &function.args else {
        return Err("COUNT requires an argument".to_string());
    };
    if arguments.duplicate_treatment.is_some() {
        return Err("COUNT DISTINCT is not supported".to_string());
    }
    if arguments.args.len() != 1 {
        return Err("COUNT requires one argument".to_string());
    }
    match &arguments.args[0] {
        FunctionArg::Unnamed(FunctionArgExpr::Wildcard) => Ok(Some(None)),
        FunctionArg::Unnamed(FunctionArgExpr::Expr(expression)) => {
            Ok(Some(Some(expression.clone())))
        }
        _ => Err("COUNT requires a column or *".to_string()),
    }
}

fn parse_limit(limit_clause: Option<&LimitClause>) -> Result<(Option<usize>, usize), String> {
    let Some(limit_clause) = limit_clause else {
        return Ok((None, 0));
    };
    match limit_clause {
        LimitClause::LimitOffset {
            limit,
            offset,
            limit_by,
        } if limit_by.is_empty() => Ok((
            limit.as_ref().map(parse_integer).transpose()?,
            offset
                .as_ref()
                .map(|offset| parse_integer(&offset.value))
                .transpose()?
                .unwrap_or(0),
        )),
        LimitClause::OffsetCommaLimit { offset, limit } => {
            Ok((Some(parse_integer(limit)?), parse_integer(offset)?))
        }
        _ => Err("This LIMIT form is not supported".to_string()),
    }
}

fn parse_integer(expression: &Expr) -> Result<usize, String> {
    match expression {
        Expr::Value(value) => match &value.value {
            Value::Number(number, _) => number
                .parse::<usize>()
                .map_err(|_| "LIMIT and OFFSET must be non-negative integers".to_string()),
            _ => Err("LIMIT and OFFSET must be non-negative integers".to_string()),
        },
        Expr::UnaryOp {
            op: UnaryOperator::Plus,
            expr,
        } => parse_integer(expr),
        _ => Err("LIMIT and OFFSET must be non-negative integers".to_string()),
    }
}

fn validate_expression(expression: &Expr, columns: &[String]) -> Result<(), String> {
    match expression {
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) | Expr::Value(_) => {
            let _ = eval_column_reference(expression, &[], columns);
            Ok(())
        }
        Expr::Nested(expression)
        | Expr::UnaryOp {
            expr: expression, ..
        } => validate_expression(expression, columns),
        Expr::BinaryOp { left, right, .. } => {
            validate_expression(left, columns)?;
            validate_expression(right, columns)
        }
        Expr::Like {
            expr,
            pattern,
            escape_char,
            ..
        }
        | Expr::ILike {
            expr,
            pattern,
            escape_char,
            ..
        } => {
            if escape_char.is_some() {
                return Err("LIKE ESCAPE is not supported".to_string());
            }
            validate_expression(expr, columns)?;
            validate_expression(pattern, columns)
        }
        Expr::IsNull(expression)
        | Expr::IsNotNull(expression)
        | Expr::IsTrue(expression)
        | Expr::IsNotTrue(expression)
        | Expr::IsFalse(expression)
        | Expr::IsNotFalse(expression) => validate_expression(expression, columns),
        Expr::InList { expr, list, .. } => {
            validate_expression(expr, columns)?;
            for item in list {
                validate_expression(item, columns)?;
            }
            Ok(())
        }
        Expr::Between {
            expr, low, high, ..
        } => {
            validate_expression(expr, columns)?;
            validate_expression(low, columns)?;
            validate_expression(high, columns)
        }
        Expr::Function(_) => Err("Only COUNT is supported as a function".to_string()),
        _ => Err(format!("Unsupported expression '{expression}'")),
    }
}

fn eval_predicate(
    expression: &Expr,
    row: &[Option<String>],
    columns: &[String],
) -> Result<Option<bool>, String> {
    match expression {
        Expr::Nested(expression) => eval_predicate(expression, row, columns),
        Expr::UnaryOp {
            op: UnaryOperator::Not,
            expr,
        } => Ok(eval_predicate(expr, row, columns)?.map(|value| !value)),
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => sql_and(
            eval_predicate(left, row, columns)?,
            eval_predicate(right, row, columns)?,
        ),
        Expr::BinaryOp {
            left,
            op: BinaryOperator::Or,
            right,
        } => sql_or(
            eval_predicate(left, row, columns)?,
            eval_predicate(right, row, columns)?,
        ),
        Expr::BinaryOp { left, op, right } if is_comparison(op) => {
            compare_expression(left, op, right, row, columns)
        }
        Expr::Like {
            negated,
            expr,
            pattern,
            ..
        } => like_expression(*negated, expr, pattern, row, columns, true),
        Expr::ILike {
            negated,
            expr,
            pattern,
            ..
        } => like_expression(*negated, expr, pattern, row, columns, false),
        Expr::IsNull(expression) => Ok(Some(eval_value(expression, row, columns)?.is_none())),
        Expr::IsNotNull(expression) => Ok(Some(eval_value(expression, row, columns)?.is_some())),
        Expr::IsTrue(expression) => Ok(Some(matches!(
            eval_predicate(expression, row, columns)?,
            Some(true)
        ))),
        Expr::IsNotTrue(expression) => Ok(Some(!matches!(
            eval_predicate(expression, row, columns)?,
            Some(true)
        ))),
        Expr::IsFalse(expression) => Ok(Some(matches!(
            eval_predicate(expression, row, columns)?,
            Some(false)
        ))),
        Expr::IsNotFalse(expression) => Ok(Some(!matches!(
            eval_predicate(expression, row, columns)?,
            Some(false)
        ))),
        Expr::InList {
            expr,
            list,
            negated,
        } => {
            let value = eval_value(expr, row, columns)?;
            let mut unknown = value.is_none();
            let found = list.iter().try_fold(false, |found, item| {
                let candidate = eval_value(item, row, columns)?;
                if candidate.is_none() {
                    unknown = true;
                }
                Ok::<_, String>(found || values_equal(value.as_ref(), candidate.as_ref()))
            })?;
            Ok(if found {
                Some(!negated)
            } else if unknown {
                None
            } else {
                Some(*negated)
            })
        }
        Expr::Between {
            expr,
            negated,
            low,
            high,
        } => {
            let value = eval_value(expr, row, columns)?;
            let low = eval_value(low, row, columns)?;
            let high = eval_value(high, row, columns)?;
            let result = match (value.as_ref(), low.as_ref(), high.as_ref()) {
                (Some(value), Some(low), Some(high)) => Some(
                    compare_cells(Some(value), Some(low)) != Ordering::Less
                        && compare_cells(Some(value), Some(high)) != Ordering::Greater,
                ),
                _ => None,
            };
            Ok(result.map(|result| if *negated { !result } else { result }))
        }
        _ => match eval_value(expression, row, columns)? {
            Some(value) if value.eq_ignore_ascii_case("true") => Ok(Some(true)),
            Some(value) if value.eq_ignore_ascii_case("false") => Ok(Some(false)),
            Some(_) => Err(format!("Expected a boolean expression, got '{expression}'")),
            None => Ok(None),
        },
    }
}

fn eval_value(
    expression: &Expr,
    row: &[Option<String>],
    columns: &[String],
) -> Result<Option<String>, String> {
    match expression {
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) => {
            eval_column_reference(expression, row, columns)
        }
        Expr::Value(value) => Ok(match &value.value {
            Value::Null => None,
            Value::Number(number, _) => Some(number.to_string()),
            Value::SingleQuotedString(value)
            | Value::DoubleQuotedString(value)
            | Value::EscapedStringLiteral(value)
            | Value::NationalStringLiteral(value) => Some(value.clone()),
            Value::Boolean(value) => Some(value.to_string()),
            _ => return Err(format!("Unsupported literal '{value}'")),
        }),
        Expr::Nested(expression) => eval_value(expression, row, columns),
        Expr::UnaryOp { op, expr } => {
            let value = eval_value(expr, row, columns)?;
            match (op, value) {
                (_, None) => Ok(None),
                (UnaryOperator::Plus, value) => Ok(value),
                (UnaryOperator::Minus, Some(value)) => numeric_value(&value, |value| -value),
                (UnaryOperator::Not, _) => {
                    Ok(eval_predicate(expr, row, columns)?.map(|value| (!value).to_string()))
                }
                _ => Err(format!("Unsupported unary operator '{op}'")),
            }
        }
        Expr::BinaryOp { left, op, right } => {
            let left = eval_value(left, row, columns)?;
            let right = eval_value(right, row, columns)?;
            match op {
                BinaryOperator::Plus => numeric_binary(left, right, |left, right| left + right),
                BinaryOperator::Minus => numeric_binary(left, right, |left, right| left - right),
                BinaryOperator::Multiply => numeric_binary(left, right, |left, right| left * right),
                BinaryOperator::Divide => numeric_binary(left, right, |left, right| left / right),
                BinaryOperator::Modulo => numeric_binary(left, right, |left, right| left % right),
                BinaryOperator::StringConcat => Ok(match (left, right) {
                    (Some(left), Some(right)) => Some(format!("{left}{right}")),
                    _ => None,
                }),
                _ => Err(format!("'{op}' is not a value expression")),
            }
        }
        _ => Err(format!("Unsupported expression '{expression}'")),
    }
}

fn eval_column_reference(
    expression: &Expr,
    row: &[Option<String>],
    columns: &[String],
) -> Result<Option<String>, String> {
    let name = match expression {
        Expr::Identifier(identifier) => &identifier.value,
        Expr::CompoundIdentifier(identifiers) => identifiers
            .last()
            .map(|identifier| &identifier.value)
            .ok_or_else(|| "Empty column reference".to_string())?,
        _ => return Err(format!("'{expression}' is not a column reference")),
    };
    let index = columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case(name))
        .ok_or_else(|| format!("Unknown column '{name}'"))?;
    Ok(row.get(index).cloned().unwrap_or(None))
}

fn compare_expression(
    left: &Expr,
    operator: &BinaryOperator,
    right: &Expr,
    row: &[Option<String>],
    columns: &[String],
) -> Result<Option<bool>, String> {
    let left = eval_value(left, row, columns)?;
    let right = eval_value(right, row, columns)?;
    if left.is_none() || right.is_none() {
        return Ok(None);
    }
    let ordering = compare_cells(left.as_ref(), right.as_ref());
    Ok(Some(match operator {
        BinaryOperator::Eq => ordering == Ordering::Equal,
        BinaryOperator::NotEq => ordering != Ordering::Equal,
        BinaryOperator::Gt => ordering == Ordering::Greater,
        BinaryOperator::GtEq => ordering != Ordering::Less,
        BinaryOperator::Lt => ordering == Ordering::Less,
        BinaryOperator::LtEq => ordering != Ordering::Greater,
        _ => return Err(format!("Unsupported comparison operator '{operator}'")),
    }))
}

fn like_expression(
    negated: bool,
    expression: &Expr,
    pattern: &Expr,
    row: &[Option<String>],
    columns: &[String],
    case_sensitive: bool,
) -> Result<Option<bool>, String> {
    let value = eval_value(expression, row, columns)?;
    let pattern = eval_value(pattern, row, columns)?;
    let result = match (value, pattern) {
        (Some(value), Some(pattern)) => Some(like_matches(&value, &pattern, case_sensitive)),
        _ => None,
    };
    Ok(result.map(|result| if negated { !result } else { result }))
}

fn like_matches(value: &str, pattern: &str, case_sensitive: bool) -> bool {
    let value = if case_sensitive {
        value.to_string()
    } else {
        value.to_ascii_lowercase()
    };
    let pattern = if case_sensitive {
        pattern.to_string()
    } else {
        pattern.to_ascii_lowercase()
    };
    like_chars(
        value.chars().collect::<Vec<_>>().as_slice(),
        pattern.chars().collect::<Vec<_>>().as_slice(),
    )
}

fn like_chars(value: &[char], pattern: &[char]) -> bool {
    match pattern.first() {
        None => value.is_empty(),
        Some('%') => {
            like_chars(value, &pattern[1..])
                || !value.is_empty() && like_chars(&value[1..], pattern)
        }
        Some('_') => !value.is_empty() && like_chars(&value[1..], &pattern[1..]),
        Some(character) => {
            !value.is_empty() && *character == value[0] && like_chars(&value[1..], &pattern[1..])
        }
    }
}

fn numeric_value(
    value: &str,
    operation: impl FnOnce(f64) -> f64,
) -> Result<Option<String>, String> {
    let value = value
        .parse::<f64>()
        .map_err(|_| format!("'{value}' is not numeric"))?;
    Ok(Some(format_number(operation(value))))
}

fn numeric_binary(
    left: Option<String>,
    right: Option<String>,
    operation: impl FnOnce(f64, f64) -> f64,
) -> Result<Option<String>, String> {
    match (left, right) {
        (Some(left), Some(right)) => {
            let left = left
                .parse::<f64>()
                .map_err(|_| format!("'{left}' is not numeric"))?;
            let right = right
                .parse::<f64>()
                .map_err(|_| format!("'{right}' is not numeric"))?;
            Ok(Some(format_number(operation(left, right))))
        }
        _ => Ok(None),
    }
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn values_equal(left: Option<&String>, right: Option<&String>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => compare_cells(Some(left), Some(right)) == Ordering::Equal,
        _ => false,
    }
}

fn is_comparison(operator: &BinaryOperator) -> bool {
    matches!(
        operator,
        BinaryOperator::Eq
            | BinaryOperator::NotEq
            | BinaryOperator::Gt
            | BinaryOperator::GtEq
            | BinaryOperator::Lt
            | BinaryOperator::LtEq
    )
}

fn sql_and(left: Option<bool>, right: Option<bool>) -> Result<Option<bool>, String> {
    Ok(match (left, right) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    })
}

fn sql_or(left: Option<bool>, right: Option<bool>) -> Result<Option<bool>, String> {
    Ok(match (left, right) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    })
}

fn compare_order_values(
    left: Option<&String>,
    right: Option<&String>,
    nulls_first: bool,
) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => {
            if nulls_first {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
        (Some(_), None) => {
            if nulls_first {
                Ordering::Greater
            } else {
                Ordering::Less
            }
        }
        (Some(left), Some(right)) => compare_cells(Some(left), Some(right)),
    }
}

fn compare_cells(left: Option<&String>, right: Option<&String>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(left), Some(right)) => match (left.parse::<f64>(), right.parse::<f64>()) {
            (Ok(left), Ok(right)) => left.partial_cmp(&right).unwrap_or(Ordering::Equal),
            _ => left.cmp(right),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn queries_csv_with_ast_features() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("people.csv");
        fs::write(&path, "name,age\nAda,36\nGrace,28\nGrace,28\nAlan,15\n").unwrap();
        let result = query_file(
            &path,
            "/workspace/people.csv",
            "SELECT DISTINCT name AS person FROM data WHERE (age >= 18 AND name LIKE 'A%') OR age BETWEEN 25 AND 30 ORDER BY age DESC LIMIT 1 OFFSET 1",
            0,
            Some(25),
        )
        .unwrap();
        assert_eq!(result.columns, ["person"]);
        assert_eq!(result.rows, [[Some("Grace".into())]]);
        assert_eq!(result.total_rows, 1);

        let count = query_file(
            &path,
            "/workspace/people.csv",
            "SELECT COUNT(*) AS total FROM data WHERE age >= 18",
            0,
            Some(25),
        )
        .unwrap();
        assert_eq!(count.columns, ["total"]);
        assert_eq!(count.rows, [[Some("3".into())]]);
    }

    #[test]
    fn supports_null_predicates_and_arithmetic_projection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("people.csv");
        fs::write(&path, "name,age\nAda,36\nGrace,\n").unwrap();
        let result = query_file(
            &path,
            "/workspace/people.csv",
            "SELECT name, age + 1 AS next_age FROM data WHERE age IS NOT NULL AND age <> ''",
            0,
            None,
        )
        .unwrap();
        assert_eq!(result.columns, ["name", "next_age"]);
        assert_eq!(result.rows, [[Some("Ada".into()), Some("37".into())]]);
    }

    #[test]
    fn rejects_mutating_sql() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("people.csv");
        fs::write(&path, "name\nAda\n").unwrap();
        let error = query_file(
            &path,
            "/workspace/people.csv",
            "DELETE FROM data",
            0,
            Some(25),
        )
        .unwrap_err();
        assert!(error.contains("read-only"));
    }
}
