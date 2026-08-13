use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::{Row, RowAccessor, RowFormatter};
use serde::Serialize;
use sqlparser::ast::Statement;
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;
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
    distinct: bool,
    filter: Vec<Filter>,
    order: Option<(usize, bool)>,
    limit: Option<usize>,
}

enum Projection {
    All,
    Column(usize),
    Count,
}

struct Filter {
    column: usize,
    operator: String,
    value: Option<String>,
}

/// Reads a CSV, TSV, or Parquet file and applies the small, predictable SQL
/// subset used by the data pane: SELECT, DISTINCT, WHERE, ORDER BY, and LIMIT.
/// Queries remain SQL-shaped so the pane is useful without making a full
/// database engine part of the desktop binary.
pub fn query_file(
    path: &Path,
    logical_path: &str,
    query: &str,
    page: usize,
    page_size: Option<usize>,
) -> Result<DataQueryResult, String> {
    let statements = Parser::parse_sql(&DuckDbDialect {}, query).map_err(|err| err.to_string())?;
    if statements.len() != 1 || !matches!(statements.first(), Some(Statement::Query(_))) {
        return Err("Only one read-only SELECT query is supported".to_string());
    }

    let mut table = read_table(path, logical_path)?;
    let parsed = parse_query(query, &table.columns)?;
    let mut rows: Vec<Vec<Option<String>>> = table
        .rows
        .drain(..)
        .filter(|row| {
            parsed
                .filter
                .iter()
                .all(|filter| matches_filter(row, filter))
        })
        .collect();

    if let Some((column, descending)) = parsed.order {
        rows.sort_by(|left, right| {
            let ordering = compare_cells(left.get(column), right.get(column));
            if descending {
                ordering.reverse()
            } else {
                ordering
            }
        });
    }

    let source_truncated = table.truncated;
    let filtered_rows = rows;
    if parsed.projection.len() == 1 && matches!(parsed.projection[0], Projection::Count) {
        let mut count_rows = filtered_rows;
        if let Some(limit) = parsed.limit {
            count_rows.truncate(limit);
        }
        return Ok(DataQueryResult {
            columns: vec!["count".to_string()],
            rows: vec![vec![Some(count_rows.len().to_string())]],
            total_rows: 1,
            truncated: source_truncated,
        });
    }

    let columns: Vec<String> = parsed
        .projection
        .iter()
        .flat_map(|projection| match projection {
            Projection::All => table.columns.clone(),
            Projection::Column(index) => vec![table.columns[*index].clone()],
            Projection::Count => Vec::new(),
        })
        .collect();
    let mut projected_rows = filtered_rows
        .into_iter()
        .map(|row| {
            parsed
                .projection
                .iter()
                .flat_map(|projection| match projection {
                    Projection::All => row.clone(),
                    Projection::Column(index) => vec![row[*index].clone()],
                    Projection::Count => Vec::new(),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if parsed.distinct {
        let mut seen = HashSet::with_capacity(projected_rows.len());
        projected_rows.retain(|row| seen.insert(row.clone()));
    }
    if let Some(limit) = parsed.limit {
        projected_rows.truncate(limit);
    }

    let total_rows = projected_rows.len();
    let start = page_size
        .map(|size| page.saturating_mul(size).min(total_rows))
        .unwrap_or(0);
    let rows_to_return = match page_size {
        Some(size) => projected_rows
            .into_iter()
            .skip(start)
            .take(size)
            .collect::<Vec<_>>(),
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

fn parse_query(query: &str, columns: &[String]) -> Result<Query, String> {
    let query = query
        .trim()
        .trim_end_matches(';')
        .trim()
        .chars()
        .map(|character| {
            if character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let lower = query.to_ascii_lowercase();
    let select_start = lower
        .strip_prefix("select ")
        .ok_or("Query must start with SELECT")?;
    let from = select_start
        .to_ascii_lowercase()
        .find(" from ")
        .ok_or("Query must select from data")?;
    let projection_text = select_start[..from].trim();
    let distinct = projection_text
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("distinct"))
        && projection_text
            .get(8..)
            .is_some_and(|remainder| remainder.chars().next().is_some_and(|c| c.is_whitespace()));
    let projection_text = if distinct {
        projection_text[8..].trim_start()
    } else {
        projection_text
    };
    let after_from = &select_start[from + 6..];
    if !after_from
        .get(..4)
        .is_some_and(|source| source.eq_ignore_ascii_case("data"))
    {
        return Err("The query source must be data".to_string());
    }

    let remainder = &after_from[4..];
    let where_pos = keyword_position(remainder, "where");
    let order_pos = keyword_position(remainder, "order by");
    let limit_pos = keyword_position(remainder, "limit");
    let clause_start = [where_pos, order_pos, limit_pos]
        .into_iter()
        .flatten()
        .min();
    if clause_start.is_none() && !remainder.trim().is_empty() {
        return Err("Unexpected text after FROM data".to_string());
    }
    let clauses = |position: Option<usize>, keyword: &str| -> Option<String> {
        position.map(|start| {
            let end = [where_pos, order_pos, limit_pos]
                .into_iter()
                .flatten()
                .filter(|candidate| *candidate > start)
                .min()
                .unwrap_or(remainder.len());
            remainder[start + 1 + keyword.len()..end].trim().to_string()
        })
    };

    let projection = projection_text
        .split(',')
        .map(|item| {
            let item = item.trim();
            if item == "*" {
                return Ok(Projection::All);
            }
            if item.eq_ignore_ascii_case("count(*)") {
                return Ok(Projection::Count);
            }
            columns
                .iter()
                .position(|column| {
                    column.eq_ignore_ascii_case(item.trim_matches('"').trim_matches('`'))
                })
                .map(Projection::Column)
                .ok_or_else(|| format!("Unknown column '{item}'"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if projection.is_empty()
        || projection
            .iter()
            .any(|item| matches!(item, Projection::Count))
            && projection.len() != 1
    {
        return Err("Use COUNT(*) by itself".to_string());
    }

    let mut filters = Vec::new();
    if let Some(where_clause) = clauses(where_pos, "where") {
        for condition in split_and_conditions(&where_clause) {
            filters.push(parse_filter(condition.trim(), columns)?);
        }
    }
    let order = clauses(order_pos, "order by")
        .map(|clause| {
            let mut parts = clause.split_whitespace();
            let name = parts
                .next()
                .ok_or_else(|| "ORDER BY needs a column".to_string())?;
            let index = columns
                .iter()
                .position(|column| column.eq_ignore_ascii_case(name))
                .ok_or_else(|| format!("Unknown column '{name}'"))?;
            let descending = parts
                .next()
                .is_some_and(|direction| direction.eq_ignore_ascii_case("desc"));
            Ok::<(usize, bool), String>((index, descending))
        })
        .transpose()?;
    let limit = clauses(limit_pos, "limit")
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| "LIMIT must be a non-negative integer".to_string())
        })
        .transpose()?;
    Ok(Query {
        projection,
        distinct,
        filter: filters,
        order,
        limit,
    })
}

fn keyword_position(input: &str, keyword: &str) -> Option<usize> {
    input.to_ascii_lowercase().find(&format!(" {keyword}"))
}

fn split_and_conditions(input: &str) -> Vec<&str> {
    let lower = input.to_ascii_lowercase();
    let mut conditions = Vec::new();
    let mut start = 0;
    let mut search_from = 0;
    while let Some(relative) = lower[search_from..].find(" and ") {
        let end = search_from + relative;
        conditions.push(&input[start..end]);
        start = end + 5;
        search_from = start;
    }
    conditions.push(&input[start..]);
    conditions
}

fn parse_filter(condition: &str, columns: &[String]) -> Result<Filter, String> {
    for operator in [">=", "<=", "!=", "<>", "=", ">", "<", " like "] {
        if let Some(position) = condition.to_ascii_lowercase().find(operator) {
            let name = condition[..position].trim();
            let value = condition[position + operator.len()..].trim();
            let column = columns
                .iter()
                .position(|candidate| candidate.eq_ignore_ascii_case(name))
                .ok_or_else(|| format!("Unknown column '{name}'"))?;
            let operator = operator.trim().to_ascii_lowercase();
            let value = value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .or_else(|| {
                    value
                        .strip_prefix('\'')
                        .and_then(|value| value.strip_suffix('\''))
                })
                .unwrap_or(value)
                .replace("''", "'");
            return Ok(Filter {
                column,
                operator,
                value: Some(value),
            });
        }
    }
    Err(format!("Unsupported WHERE condition '{condition}'"))
}

fn matches_filter(row: &[Option<String>], filter: &Filter) -> bool {
    let Some(left) = row.get(filter.column).and_then(|value| value.as_ref()) else {
        return false;
    };
    let right = filter.value.as_deref().unwrap_or_default();
    if filter.operator == "like" {
        let needle = right.trim_matches('%').to_ascii_lowercase();
        return left.to_ascii_lowercase().contains(&needle);
    }
    let ordering = match (left.parse::<f64>(), right.parse::<f64>()) {
        (Ok(left), Ok(right)) => left.partial_cmp(&right),
        _ => Some(left.as_str().cmp(right)),
    };
    match (filter.operator.as_str(), ordering) {
        ("=", Some(std::cmp::Ordering::Equal)) => true,
        ("!=", Some(ordering)) | ("<>", Some(ordering)) => ordering != std::cmp::Ordering::Equal,
        (">", Some(ordering)) => ordering == std::cmp::Ordering::Greater,
        (">=", Some(ordering)) => ordering != std::cmp::Ordering::Less,
        ("<", Some(ordering)) => ordering == std::cmp::Ordering::Less,
        ("<=", Some(ordering)) => ordering != std::cmp::Ordering::Greater,
        _ => false,
    }
}

fn compare_cells(
    left: Option<&Option<String>>,
    right: Option<&Option<String>>,
) -> std::cmp::Ordering {
    let left = left.and_then(Option::as_deref).unwrap_or("");
    let right = right.and_then(Option::as_deref).unwrap_or("");
    match (left.parse::<f64>(), right.parse::<f64>()) {
        (Ok(left), Ok(right)) => left
            .partial_cmp(&right)
            .unwrap_or(std::cmp::Ordering::Equal),
        _ => left.cmp(right),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn queries_csv_with_filter_and_order() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("people.csv");
        fs::write(&path, "name,age\nAda,36\nGrace,28\nGrace,28\n").unwrap();
        let result = query_file(
            &path,
            "/workspace/people.csv",
            "SELECT name, age FROM DATA WHERE age > 30 ORDER BY age DESC",
            0,
            Some(25),
        )
        .unwrap();
        assert_eq!(result.columns, ["name", "age"]);
        assert_eq!(result.rows, [[Some("Ada".into()), Some("36".into())]]);
        assert_eq!(result.total_rows, 1);

        let distinct = query_file(
            &path,
            "/workspace/people.csv",
            "SELECT DISTINCT name FROM data ORDER BY age DESC",
            0,
            Some(25),
        )
        .unwrap();
        assert_eq!(distinct.columns, ["name"]);
        assert_eq!(
            distinct.rows,
            [[Some("Ada".into()),], [Some("Grace".into())]]
        );
        assert_eq!(distinct.total_rows, 2);

        let count = query_file(
            &path,
            "/workspace/people.csv",
            "SELECT COUNT(*) FROM data WHERE age > 30",
            0,
            Some(25),
        )
        .unwrap();
        assert_eq!(count.rows, [[Some("1".into())]]);

        let page = query_file(
            &path,
            "/workspace/people.csv",
            "SELECT name FROM data ORDER BY age DESC",
            1,
            Some(1),
        )
        .unwrap();
        assert_eq!(page.rows, [[Some("Grace".into())]]);
        assert_eq!(page.total_rows, 3);
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
