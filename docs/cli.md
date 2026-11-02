# Sender (`diodecam`)

Broadcasts one file as a grid of frames in the terminal, forever, until you quit. The format is [protocol.md](protocol.md).

```
diodecam send <FILE> [--fps 24] [--profile auto|ssh|vt100] [--max-bytes 64MiB] [--no-compress]
diodecam --help | --version
```

- `<FILE>` is one regular file. Pack a folder with `tar czf out.tgz dir/`. Devices, FIFOs, files over the limit and output that is not a terminal are refused before the screen changes.
- `--fps` 1–60. At 30 a 30 fps camera can lock in phase with the sender; the sender warns.
- `--profile`: `ssh` draws `▀` half blocks (two modules per cell), `vt100` draws spaces with reverse video. `auto` picks one (protocol §1).

## Screen

The grid fills the terminal above two status lines:

```
 DiodeCam  report.pdf 1.00 MB -> 412 KB deflate  id 3f2a9c1e  ssh 199x106  19 tiles 1.73 KB/frame
 00:41  source 100% [##########]  +repair 13,420  24 fps  41.5 KB/s  phone needs ~10s of view  [+/-] fps [space] pause [q] quit
```

`source` is the first pass over the file's symbols; `+repair` counts the repair symbols sent since. `phone needs` is about how long the phone has to watch to collect K + 2 symbols at the current rate.

Resizing the terminal is fine: the next frame uses the new layout and the transfer carries on. A terminal too small for the grid shows the minimum size until it grows.

## Keys and exit

| Key | Action |
|---|---|
| `+` / `-` | Frame rate up / down (2, 3, 5, 8, 10, 12, 15, 20, 24, 30) |
| space | Pause / resume |
| `q`, Esc, Ctrl-C | Quit and restore the terminal |

Exit codes: 0 done, 1 input error, 2 usage error, 129 terminal gone (SIGHUP or stdin closed), 130 Ctrl-C, 143 SIGTERM.
