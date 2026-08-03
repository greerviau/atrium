import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { basename } from "../util/path";

const loadHcl = () => import("codemirror-lang-hcl").then(({ hcl }) => hcl());

const terraform = LanguageDescription.of({
  name: "Terraform",
  extensions: ["tf", "tfvars"],
  load: loadHcl,
});

const hcl = LanguageDescription.of({
  name: "HCL",
  extensions: ["hcl"],
  load: loadHcl,
});

const shellScript = LanguageDescription.of({
  name: "Shell Script",
  alias: ["bash", "sh", "shell", "zsh"],
  extensions: ["sh", "bash", "zsh", "ksh"],
  filename: /^PKGBUILD$/,
  load: () =>
    import("@codemirror/legacy-modes/mode/shell").then(
      ({ shell }) => new LanguageSupport(StreamLanguage.define(shell)),
    ),
});

const codeLanguages = [terraform, hcl, shellScript, ...languages];

/** Finds Atrium's CodeMirror language for a path, including extensionless conventional filenames. */
export function codeLanguageForPath(path: string): LanguageDescription | null {
  const filename = basename(path);
  return (
    LanguageDescription.matchFilename(codeLanguages, filename) ??
    LanguageDescription.matchFilename(codeLanguages, filename.toLowerCase())
  );
}
