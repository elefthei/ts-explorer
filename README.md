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

## How to Use

Start the explorer with the default source directory:

```sh
bun run start
```

Open <http://localhost:8080> in a browser.

To inspect another repository, pass `--source`:

```sh
bun run start -- --source /path/to/project
```

The source path may use `~`:

```sh
bun run start -- --source ~/git/junco-runtime
```

### CLI options

| Option | Default | Description |
| --- | --- | --- |
| `--source` | `/home/eioannidis/git/junco-runtime` | Source directory to inspect |
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8080` | HTTP/WebSocket port |

For example, to use a different local port:

```sh
bun run start -- --source ~/git/my-project --host 127.0.0.1 --port 8081
```

Use `--host 0.0.0.0` only when you intentionally want the server reachable beyond the local machine.

## Explorer workflow

- **Packages** shows workspace package dependencies as a Mermaid graph.
- **UML** shows TsUML2 class relationships for the selected package or folder, grouped into vertically stacked Louvain communities to keep large diagrams readable. Boundary types can appear in adjacent frames so cross-community relationships remain visible.
- The file tree lists packages, folders, and files. Use the filter to narrow it.
- Select a TypeScript file to open it in the editor. Other text files are read-only.
- **Format** formats the editor buffer in memory with Prettier.
- **Save** writes the selected TypeScript file to disk. `Ctrl+S` or `Cmd+S` also saves.
- Saves use a content hash, so an external edit is rejected instead of being overwritten silently.
- The graph supports wheel zoom, pointer-drag panning, and reset-to-fit controls.
- The browser receives filesystem changes over WebSocket and refreshes the tree and current diagram without polling.
- If the open editor has unsaved changes when the file changes on disk, the browser preserves the buffer and offers **Reload** or **Keep mine**.

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
- `GET /api/diagram?kind=packages&path=`
- `GET /api/diagram?kind=uml&path=<relative-scope>`
- `GET /api/file?path=<relative-path>`
- `POST /api/file/format` with `{ "path", "content" }`
- `PUT /api/file` with `{ "path", "content", "baseHash" }`
- `GET /ws` for filesystem change notifications

All file paths are constrained to the configured source directory. Writes are limited to existing UTF-8 TypeScript files (`.ts`, `.tsx`, `.mts`, and `.cts`), excluding declaration files.
