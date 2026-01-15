//! CLI tool for managing domain mappings
//!
//! Usage:
//!   rustproxy-mapping add <domain> <port> [options]
//!   rustproxy-mapping delete <domain> [--frontend <path>]
//!   rustproxy-mapping list [--domain <domain>]
//!   rustproxy-mapping update <domain> <port> [options]

use anyhow::Result;
use clap::{Parser, Subcommand};
use rustproxy::DatabaseManager;
use std::path::PathBuf;

/// CLI tool for managing proxy domain mappings
#[derive(Parser, Debug)]
#[command(name = "rustproxy-mapping")]
#[command(author = "RustProxy Contributors")]
#[command(version = "1.0.0")]
#[command(about = "Manage domain mappings for RustProxy")]
struct Args {
    /// Database path
    #[arg(long, env = "DB_PATH", default_value = "./data/current.db")]
    db_path: PathBuf,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Add a new domain mapping
    Add {
        /// Domain name (e.g., api.example.com)
        domain: String,

        /// Backend port
        port: u16,

        /// Frontend URI path (without leading slash)
        #[arg(short = 'f', long)]
        frontend: Option<String>,

        /// Backend URI path (without leading slash)
        #[arg(short = 'b', long)]
        backend: Option<String>,

        /// Set both frontend and backend URI to the same value
        #[arg(long)]
        both: Option<String>,

        /// External backend server URL (e.g., https://api.external.com)
        #[arg(short = 's', long)]
        server: Option<String>,
    },

    /// Update an existing mapping
    Update {
        /// Domain name
        domain: String,

        /// Backend port
        port: Option<u16>,

        /// Frontend URI path
        #[arg(short = 'f', long)]
        frontend: Option<String>,

        /// Backend URI path
        #[arg(short = 'b', long)]
        backend: Option<String>,

        /// Set both frontend and backend URI to the same value
        #[arg(long)]
        both: Option<String>,

        /// External backend server URL
        #[arg(short = 's', long)]
        server: Option<String>,

        /// Current frontend URI to identify the mapping
        #[arg(long)]
        current_frontend: Option<String>,
    },

    /// Delete a domain mapping
    Delete {
        /// Domain name
        domain: String,

        /// Frontend URI path (to delete specific mapping)
        #[arg(short = 'f', long)]
        frontend: Option<String>,
    },

    /// List all mappings
    List {
        /// Filter by domain
        #[arg(short = 'd', long)]
        domain: Option<String>,

        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize database
    let db = DatabaseManager::new(&args.db_path)?;

    match args.command {
        Commands::Add {
            domain,
            port,
            frontend,
            backend,
            both,
            server,
        } => {
            let front_uri = both.as_ref().or(frontend.as_ref()).map(|s| s.as_str()).unwrap_or("");
            let back_uri = both.as_ref().or(backend.as_ref()).map(|s| s.as_str()).unwrap_or("");

            let mapping = db.add_mapping(&domain, front_uri, port, back_uri, server.as_deref())?;

            println!("Added mapping:");
            print_mapping(&mapping);
        }

        Commands::Update {
            domain,
            port,
            frontend,
            backend,
            both,
            server,
            current_frontend,
        } => {
            let front_uri_for_lookup = current_frontend.as_ref().or(frontend.as_ref()).map(|s| s.as_str()).unwrap_or("");

            // Find existing mapping
            let existing = db.find_by_domain_and_uri(&domain, front_uri_for_lookup)?;

            match existing {
                Some(mapping) => {
                    let new_front = both.as_ref().or(frontend.as_ref()).map(|s| s.as_str());
                    let new_back = both.as_ref().or(backend.as_ref()).map(|s| s.as_str());

                    db.update_mapping(&mapping.id, new_front, new_back, port, server.as_deref())?;
                    println!("Updated mapping for {} ({})", domain, front_uri_for_lookup);
                }
                None => {
                    eprintln!("No mapping found for {} with frontend URI '{}'", domain, front_uri_for_lookup);
                    std::process::exit(1);
                }
            }
        }

        Commands::Delete { domain, frontend } => {
            let deleted = db.delete_mapping(&domain, frontend.as_deref())?;

            if deleted > 0 {
                println!("Deleted {} mapping(s) for {}", deleted, domain);
            } else {
                eprintln!("No mappings found for {}", domain);
                std::process::exit(1);
            }
        }

        Commands::List { domain, json } => {
            let mappings = db.list_mappings(domain.as_deref())?;

            if mappings.is_empty() {
                if domain.is_some() {
                    println!("No mappings found for domain: {}", domain.unwrap());
                } else {
                    println!("No mappings found");
                }
                return Ok(());
            }

            if json {
                let json_output: Vec<serde_json::Value> = mappings
                    .iter()
                    .map(|m| {
                        serde_json::json!({
                            "id": m.id,
                            "domain": m.domain,
                            "front_uri": m.front_uri,
                            "back_port": m.back_port,
                            "back_uri": m.back_uri,
                            "backend": m.backend,
                            "created_at": m.created_at,
                            "updated_at": m.updated_at,
                        })
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&json_output)?);
            } else {
                println!("{:<40} {:<15} {:<8} {:<15} {:<30}",
                    "DOMAIN", "FRONT_URI", "PORT", "BACK_URI", "BACKEND");
                println!("{}", "-".repeat(108));

                for mapping in &mappings {
                    let backend = mapping.backend.as_deref().unwrap_or("localhost");
                    println!("{:<40} {:<15} {:<8} {:<15} {:<30}",
                        mapping.domain,
                        if mapping.front_uri.is_empty() { "/" } else { &mapping.front_uri },
                        mapping.back_port,
                        if mapping.back_uri.is_empty() { "/" } else { &mapping.back_uri },
                        backend
                    );
                }

                println!("\nTotal: {} mapping(s)", mappings.len());
            }
        }
    }

    Ok(())
}

fn print_mapping(mapping: &rustproxy::Mapping) {
    println!("  ID:         {}", mapping.id);
    println!("  Domain:     {}", mapping.domain);
    println!("  Front URI:  /{}", mapping.front_uri);
    println!("  Back Port:  {}", mapping.back_port);
    println!("  Back URI:   /{}", mapping.back_uri);
    if let Some(ref backend) = mapping.backend {
        println!("  Backend:    {}", backend);
    }
    println!("  Created:    {}", mapping.created_at);
}
