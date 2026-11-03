# DiodeCam

Move a file from a terminal to a phone through the camera. One way, offline: no network, no USB, no app to install.

<p align="center">
  <img src="web/example-terminal.svg" alt="The terminal while sending: a grid of half blocks and two status lines" height="300">
  <img src="docs/images/receiver-receiving.jpg" alt="The phone receiver while receiving" height="300">
  <img src="docs/images/receiver-done.jpg" alt="The phone receiver when the file is verified" height="300">
</p>

## Use

Open **https://cagojeiger.github.io/diodecam/** on a computer. It shows the download command for your server and a QR code for the phone.

1. **Download** the sender on the server:
   ```sh
   curl -fsSL https://github.com/cagojeiger/diodecam/releases/latest/download/diodecam-x86_64-unknown-linux-musl.tar.gz | tar xz
   ```
   Other builds: `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`, `x86_64-apple-darwin`.
2. **Send** one regular file: `./diodecam-x86_64-unknown-linux-musl/diodecam send <FILE>`. The terminal keeps broadcasting until you press `q`.
3. **Receive**: scan the QR with the phone, tap **Start** and frame the whole terminal. Holding the phone sideways reads better.
4. When it says **✓ Received**, use **Share · Save** or **Download**. Check the file is saved, then press `q` on the server.

Keys while sending: `+`/`-` frame rate, space pause, `q` quit. `diodecam --help` lists the options. Pack a folder with `tar czf` first.

The sender's KB/s assumes every tile is read; the phone shows measured time and speed after an uninterrupted transfer ([measuring](docs/development.md#speed-on-a-phone)).

## Safety

- Moving data out of a restricted network needs your organisation's approval. A camera is an export channel like any other.
- The screen is not encrypted: anyone who can see or film it can receive the file. SHA-256 proves the file arrived intact, not who sent it.
- The receiver uploads nothing and never opens the file. It keeps a local copy for recovery; Share or Download exports it ([storage and expiry](docs/web.md#4-storage)).
- The page is served from `*.github.io`, whose browser storage is shared with other Pages sites of the same account. For sensitive use, host `web/` on your own HTTPS domain.

## Docs

- [Receiver](docs/web.md): options, storage and diagnostics.
- [Development](docs/development.md): architecture, build, test and release.
- [Protocol](docs/protocol.md): the exact screen format.

## License

Apache-2.0. Third-party licenses: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
