use std::{env, process::ExitCode};
use yonalist_sync::{run_corrupt_pack, run_mesh, run_revocation, ScenarioConfig, ScenarioSummary};

fn main() -> ExitCode {
    match parse(env::args().skip(1).collect()) {
        Ok(summary) => match serde_json::to_string(&summary) {
            Ok(json) => {
                println!("{json}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("sync-lab: {error}");
                ExitCode::FAILURE
            }
        },
        Err(message) => {
            eprintln!("sync-lab: {message}");
            ExitCode::from(2)
        }
    }
}

fn parse(args: Vec<String>) -> Result<ScenarioSummary, String> {
    let Some((command, options)) = args.split_first() else {
        return Err(usage());
    };
    let mut peers = None;
    let mut events = None;
    let mut seed = None;
    let mut index = 0;
    while index < options.len() {
        let name = &options[index];
        let value = options.get(index + 1).ok_or_else(usage)?;
        let slot = match name.as_str() {
            "--peers" if command == "mesh" => &mut peers,
            "--events" if command == "mesh" => &mut events,
            "--seed" => &mut seed,
            _ => return Err(usage()),
        };
        if slot.is_some() {
            return Err(usage());
        }
        *slot = Some(value.parse::<u64>().map_err(|_| usage())?);
        index += 2;
    }
    let seed = seed.ok_or_else(usage)?;
    match command.as_str() {
        "mesh" => {
            let peers = peers.ok_or_else(usage)?;
            let events = events.ok_or_else(usage)?;
            let peers = usize::try_from(peers).map_err(|_| usage())?;
            let events = usize::try_from(events).map_err(|_| usage())?;
            if !(1..=100).contains(&peers) || events > 10_000 {
                return Err(usage());
            }
            run_mesh(ScenarioConfig {
                peers,
                events,
                seed,
            })
            .map_err(|error| error.message)
        }
        "revocation" if peers.is_none() && events.is_none() => {
            run_revocation(seed).map_err(|error| error.message)
        }
        "corrupt-pack" if peers.is_none() && events.is_none() => {
            run_corrupt_pack(seed).map_err(|error| error.message)
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: sync-lab mesh --peers <1..100> --events <0..10000> --seed <u64> | sync-lab revocation --seed <u64> | sync-lab corrupt-pack --seed <u64>".into()
}
