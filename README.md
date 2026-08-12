# TypeScript Explorer

A local TypeScript project explorer for workspace repositories. It statically analyzes source files, renders package dependencies and UML relationships, watches the filesystem for external changes, and provides an editor for TypeScript files.

The explorer never imports or executes the inspected project.

## Requirements

- [Bun](https://bun.sh/) 1.3.14 or newer
- A TypeScript workspace or source directory to inspect

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

## Explorer workflow

- **Packages** shows workspace package dependencies as a Mermaid graph.
- **UML** shows class relationships for the selected package or folder, grouped into vertically stacked Louvain communities to keep large diagrams readable. Boundary types can appear in adjacent frames so cross-community relationships remain visible.
- The file tree lists packages, folders, and files. Use the filter to narrow it.
- Select a TypeScript or JavaScript source file to open it in the read-only editor; other files are not viewable.
- The editor shows the Prettier-formatted source produced during preprocessing, syntax-highlighted from spans the server computes with tree-sitter. It is never editable, and the explorer never writes to the inspected project.
- Class, interface, enum, type, and method names are underlined in the editor. Click one to jump straight to its declaration; the target comes from a definition index written at the start of every preprocessing generation, so the jump never waits on UML extraction of the target file.
- Search matches file contents and definition names. Selecting a definition result opens the declaration in the editor or highlights it in the UML diagram.
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
- `GET /api/diagram?kind=uml&path=<relative-scope>`
- `GET /api/file?path=<relative-path>` with optional `line` and `column` to place the cursor
- `GET /api/goto-definition?path=<relative-path>&line=<line>&column=<column>` resolves the definition under a source position, including its UML scope
- `GET /api/definition?path=<relative-path>&name=<name>&qualifiedName=<qualified-name>` resolves a declaration's source position from the definition index
- `POST /api/preprocess` with `{ "action": "prioritize", "resource" }` or `{ "action": "poll", "requestId" }`
- `GET /ws` for filesystem change notifications

All file paths are constrained to the configured source directory. Every endpoint is read-only; the server exposes no write route.
