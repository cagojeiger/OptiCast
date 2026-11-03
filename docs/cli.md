# Sender (`diodecam`)

Run `diodecam send <FILE>` to broadcast one file until you quit. `diodecam --help` is the reference for options, defaults and sending keys. The screen format is [protocol.md](protocol.md).

Only regular files are accepted; pack directories with `tar czf out.tgz dir/`. Devices, FIFOs, files over the limit and non-terminal output are refused before the screen changes.
At 30 fps, a 30 fps camera can lock in phase with the sender; the sender warns. Choose another rate if frames are missed.

## Screen

The grid fills the terminal above two status lines (pictured in the [README](../README.md)).
`source` is the first pass over the file's symbols; `+repair` counts repair symbols sent since. `phone needs` estimates viewing time at the current rate with no missed tiles; decoding may need extra repair symbols.
Resizing uses the new layout on the next frame without restarting the transfer. A terminal too small for the grid shows the required minimum size until it grows.

## Exit

Quit with `q`, Esc or Ctrl-C to restore the terminal. Exit codes: 0 quit, 1 file or terminal error, 2 usage error, 129 terminal gone (SIGHUP or stdin closed), 130 Ctrl-C, 143 SIGTERM.
