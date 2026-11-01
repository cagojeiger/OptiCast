//! Stage-by-stage diagnosis of chosen cases: `cargo test --test diagnose -- --ignored --nocapture`.
mod common;
use common::*;
use opticast_core::Profile;
use opticast_vision::Vision;

fn stages(name: &str, case: Case) {
    let mut sender = Sender::new(&case, 200_000);
    let term = terminal(&case);
    for i in 0..3 {
        let (grid, t) = sender.next();
        let screen = term.rasterize(&grid);
        let shot = camera(&case, &screen, case.seed * 1000 + i).shoot(&screen);
        let mut v = Vision::new();
        let d = v.process(&shot.data, shot.width, shot.height);
        let o = score(d.as_ref(), &sender.layout, &grid, &[&t]);
        println!("{name} frame {i}: stage {:?} tiles {}/{} residual {:.2}", v.stage(), o.tiles_ok, o.tiles, o.residual);
        if d.is_none() {
            for c in v.candidates() {
                println!("    {c:?}");
            }
        }
    }
}

#[test]
#[ignore]
fn diagnose() {
    let m = Case {
        yaw: 8.0,
        pitch: -5.0,
        roll: 3.0,
        blur: 1,
        noise: 8.0,
        line_gap: 2,
        levels: (30.0, 220.0),
        surround: 25,
        ..Case::default()
    };
    let h = Case {
        yaw: 12.0,
        pitch: 6.0,
        roll: 3.0,
        blur: 2,
        noise: 16.0,
        line_gap: 3,
        levels: (40.0, 210.0),
        surround: 35,
        ..Case::default()
    };
    let which = std::env::var("CASE").unwrap_or_default();
    for (name, case) in [
        ("vt100", Case { profile: Profile::Vt100, ..m }),
        ("yaw-18", Case { yaw: -18.0, pitch: 12.0, fill: 0.7, ..m }),
        ("harsh720", Case { camera: (1280, 720), seed: 3, ..h }),
    ] {
        if which.is_empty() || which == name {
            stages(name, case);
        }
    }
}
