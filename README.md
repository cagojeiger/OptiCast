# DiodeCam

Move a file from a terminal to a phone through the camera. One way, offline: no network, no USB, no app to install.

<p align="center">
  <img src="web/example-terminal.svg" alt="The terminal while sending: a grid of half blocks and two status lines" height="300">
  <img src="docs/images/receiver-receiving.jpg" alt="The phone receiver while receiving" height="300">
  <img src="docs/images/receiver-done.jpg" alt="The phone receiver when the file is verified" height="300">
</p>

## Use

Open **https://cagojeiger.github.io/diodecam/** on a computer. It shows the download command for your server and a QR code for the phone.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/setup-dark.png">
  <img src="docs/images/setup-light.png" alt="The setup page: download, send, open the receiver, receive">
</picture>

1. **Download** the sender on the server:
   ```sh
   curl -fsSL https://github.com/cagojeiger/diodecam/releases/latest/download/diodecam-x86_64-unknown-linux-musl.tar.gz | tar xz
   ```
   Other builds: `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`, `x86_64-apple-darwin`.
2. **Send**: `./diodecam-x86_64-unknown-linux-musl/diodecam send <FILE>`. The terminal keeps broadcasting until you press `q`.
3. **Receive**: scan the QR with the phone, tap **Start** and frame the whole terminal. Holding the phone sideways reads better.
4. When it says **✓ Received**, use **Share · Save** or **Download**. Check the file is saved, then press `q` on the server.

Keys while sending: `+`/`-` frame rate, space pause, `q` quit. `diodecam --help` lists the options. Pack a folder with `tar czf` first.

## Speed

24 fps, incompressible data, every tile read (the best case). The grid fills the terminal, so a bigger terminal is faster.

| Terminal | Per second | 1 MiB |
|---|---|---|
| 80×24 | 4.1 KB/s | ~4 min |
| 120×40 | 15 KB/s | ~71 s |
| 200×55 | 41.5 KB/s | ~26 s |

When a file arrives, the phone shows how long it took and the speed it got ([measuring](docs/development.md#speed-on-a-phone)).

## How it works

`file → RaptorQ symbols → RS/CRC tiles → terminal → camera → rebuild → SHA-256`

The sender keeps broadcasting fresh repair symbols, so the phone can join late and recover missed pieces. Each tile is checked separately; the rebuilt file is offered for saving only after its size and SHA-256 match.

## Safety

- Moving data out of a restricted network needs your organisation's approval. A camera is an export channel like any other.
- The screen is not encrypted: anyone who can see or film it can receive the file. SHA-256 proves the file arrived intact, not who sent it.
- The receiver uploads nothing and never opens the file. It keeps a local copy for recovery; Share or Download exports it ([storage and expiry](docs/web.md#4-storage)).
- The page is served from `*.github.io`, whose browser storage is shared with other Pages sites of the same account. For sensitive use, host `web/` on your own HTTPS domain.

## Docs

- [Sender](docs/cli.md) · [Receiver](docs/web.md): operation and troubleshooting.
- [Development](docs/development.md): architecture, build, test and release.
- [Protocol](docs/protocol.md): the exact screen format.
- [Design](DESIGN.md): UI principles.

## License

Apache-2.0. Third-party licenses: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
