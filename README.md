# TypeScript Explorer

A local TypeScript and Rust project explorer for workspace repositories. It statically analyzes source files, renders package dependencies and UML relationships, watches the filesystem for external changes, and provides an editor for source files. TypeScript, JavaScript and Rust feed one project-wide declaration catalogue, so a dependency graph crosses files, directories and packages; name resolution stays inside each language.

The explorer never imports or executes the inspected project.

## Requirements

- [Bun](https://bun.sh/) 1.3.14 or newer
- A TypeScript or Rust workspace, or a source directory to inspect

## Install

```sh
bun install
```

To put the `ts-explorer` command (and its `tse` alias) on your PATH, link the package globally (creates the shim in Bun's global bin directory):

```sh
bun link
```

Remove it again with `bun unlink` from this directory.

## How to Use

After linking, run the explorer from anywhere:

```sh
tse /path/to/project
```

It launches your default browser at <http://127.0.0.1:8080>. Pass `--no-open` to keep the terminal-only behavior.

The source path may use `~`:

```sh
tse ~/git/junco-runtime
```

Without linking, run it from this repository:

```sh
bun run start -- /path/to/project
```

### CLI options

```sh
tse <dir> [options]
```

| Argument | Default | Description |
| --- | --- | --- |
| `<dir>` | _required_ | Source directory to inspect (positional) |
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8080` | HTTP/WebSocket port |
| `--open` | `true` | Launch the default browser at the served URL; disable with `--no-open` |
| `-v`, `--version` | | Print the version from `package.json` and exit |
| `-h`, `--help` | | Print usage and exit |

For example, to use a different local port:

```sh
tse ~/git/my-project --host 127.0.0.1 --port 8081
```

Use `--host 0.0.0.0` only when you intentionally want the server reachable beyond the local machine.

### Preprocessing cache

The explorer keeps its analysis database in `.explore/explore.db` inside the inspected directory.

Windows exploring a WSL directory (`\\wsl.localhost\<distro>\…` or the equivalent `\\wsl$\…`) is the
one exception. SQLite cannot acquire a file lock over the WSL network redirector — every statement
fails with `database is locked` — so the cache moves to
`%LOCALAPPDATA%\ts-explorer\<directory-name>-<hash>\explore.db`, keyed by the canonical source root.
The four spellings of one WSL path share a single cache directory, while Linux path case stays
significant — `…/Project` and `…/project` are different roots with different caches. Deleting the
cache directory discards the cache, and deleting the project does not. Filesystem watching also
switches to 1 s polling for those roots, because the redirector does not deliver
`ReadDirectoryChangesW` notifications.

## Explorer workflow

- **Packages** shows workspace package dependencies as a Mermaid graph.
- **UML** shows the outgoing dependency graph of whatever the tree has selected. Selecting a definition roots one graph at it; selecting a file stacks one frame per top-level declaration in source order; selecting a directory shows a file-import graph of its subtree, with directly imported files outside the subtree drawn as dashed boundary leaves. Dependencies are statically resolved uses: transitive, outgoing only, and never inferred by a compiler.
- The file tree lists packages, folders, and files. Use the filter to narrow it.
- The chevron beside a row expands it; clicking the row itself selects its UML graph and never opens the editor. Expanding a file lists its definitions underneath it: each row shows the qualified name, the declaration kind, and the type as written in the source. Constants, free functions, types, fields, methods, and named namespace or module members are all listed; function-local declarations and parameters are not. Clicking the file again collapses the list. Types come from source annotations and callable signatures, never from compiler inference, so an unannotated value shows `—`.
- Double-click a file, a definition, a diagram box, or a search result to open its source in the read-only editor; `Ctrl`+`Enter` does the same from the keyboard. Files with no indexed declarations, including non-source files, expand to `No definitions`.
- The editor shows the Prettier-formatted source produced during preprocessing (Rust is served exactly as written), syntax-highlighted from spans the server computes with tree-sitter. It is never editable, and the explorer never writes to the inspected project.
- Class, interface, enum, type, and method names are underlined in the editor. Click one to jump straight to its declaration; the target comes from a definition index written at the start of every preprocessing generation, so the jump never waits on UML extraction of the target file.
- Search matches file contents and definition names. Selecting a definition result roots the UML graph at that declaration; double-clicking it opens the source. Clicking anywhere outside the search box hides the result list while keeping the query, the matches, and the tree highlighting; focusing or clicking the box shows them again without re-running the search.
- The graph supports wheel zoom, pointer-drag panning, and reset-to-fit controls.
- The browser receives filesystem changes over WebSocket and refreshes the tree and current diagram without polling.

Use the **Legend** button and **Raw Mermaid DSL** disclosure for diagram styling and debugging details.

## Development

Run the typecheck:

```sh
bun run typecheck
```

Run the behavior tests:

```sh
bun test test/*.test.ts
```

The tests use temporary fixture workspaces and never write to the configured source repository.

## HTTP endpoints

The server exposes these local endpoints:

- `GET /api/tree`
- `GET /api/packages`
- `GET /api/search?q=<literal>&caseInsensitive=<true|false>`
- `GET /api/diagram?kind=packages&path=`
- `GET /api/diagram?kind=uml&target=definition&path=<relative-file>&definition=<definition-key>`
- `GET /api/diagram?kind=uml&target=file&path=<relative-file>`
- `GET /api/diagram?kind=uml&target=directory&path=<relative-directory>` (empty path is the project root)
- `GET /api/file?path=<relative-path>` with optional `line` and `column` to place the cursor
- `GET /api/goto-definition?path=<relative-path>&line=<line>&column=<column>` resolves the definition under a source position, including its UML scope
- `GET /api/definition?path=<relative-path>&name=<name>&qualifiedName=<qualified-name>` resolves a declaration's source position from the definition index
- `GET /api/file-definitions?path=<relative-file>` lists every declaration the file contributes to the tree outline, in source order, each with the stable key the UML routes address it by
- `POST /api/preprocess` with `{ "action": "prioritize", "resource" }` or `{ "action": "poll", "requestId" }`
- `GET /ws` for filesystem change notifications

All file paths are constrained to the configured source directory. Every endpoint is read-only; the server exposes no write route.
