//! Times `Vision::process` on simulated camera frames (run with `--release`):
//!
//!     cargo run --release -p opticast-vision --example bench
//!
//! Reports full search (fresh `Vision` each frame), tracking (one `Vision`
//! across frames) and an empty view (no grid: the worst case per frame) for
//! 1920×1080 and 1280×720 views of a 200x55 terminal.

use std::time::Instant;

use opticast_core::{frame, Layout, Profile, SendOptions, Transfer};
use opticast_sim::{view, Camera, Rng, Terminal};
use opticast_vision::Vision;

fn main() {
    let layout = Layout::for_terminal(Profile::Ssh, 200, 55).unwrap();
    let mut tx = Transfer::prepare(&Rng::new(7).bytes(300_000), "b", SendOptions { compress: false }, 1).unwrap();
    let term = Terminal { line_gap: 2, ..Terminal::new(200, 55) };
    for (w, h) in [(1920, 1080), (1280, 720)] {
        let shots: Vec<_> = (0..20)
            .map(|i| {
                let screen = term.rasterize(&frame::render(&layout, &tx.next_frame(&layout)));
                let aspect = screen.width as f64 / screen.height as f64;
                let corners = view(w, h, aspect, 0.85, 8.0, 4.0, 2.0);
                Camera { blur: 1, noise: 8.0, levels: (30.0, 220.0), seed: i, ..Camera::new(w, h, corners) }
                    .shoot(&screen)
            })
            .collect();
        let mut vision = Vision::new();
        for (label, fresh) in [("full search", true), ("tracking", false)] {
            let mut times = Vec::new();
            let mut found = 0;
            for _ in 0..5 {
                for s in &shots {
                    if fresh {
                        vision.reset();
                    }
                    let t = Instant::now();
                    let d = vision.process(&s.data, s.width, s.height);
                    times.push(t.elapsed().as_secs_f64() * 1000.0);
                    found += d.is_some() as usize;
                }
            }
            times.sort_by(f64::total_cmp);
            let mean = times.iter().sum::<f64>() / times.len() as f64;
            println!(
                "{w}x{h} {label:12} mean {mean:6.2} ms  median {:6.2}  p95 {:6.2}  found {found}/{}",
                times[times.len() / 2],
                times[times.len() * 95 / 100],
                times.len()
            );
        }
        // Nothing on screen but a desk: every frame runs the full search to the end.
        let empty = Camera { noise: 8.0, seed: 99, ..Camera::new(w, h, view(w, h, 1.8, 0.85, 0.0, 0.0, 0.0)) }
            .shoot(&opticast_sim::Gray::new(1608, 892, 60));
        let mut times: Vec<f64> = (0..20)
            .map(|_| {
                let t = Instant::now();
                assert!(vision.process(&empty.data, w, h).is_none());
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        times.sort_by(f64::total_cmp);
        println!("{w}x{h} {:12} median {:6.2} ms", "empty view", times[times.len() / 2]);
    }
}
