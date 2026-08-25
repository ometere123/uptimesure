//! UptimeSure — executable API uptime guarantees on Rialo.
//!
//! A provider starts a long-running Venus workflow for one HTTPS endpoint.
//! Rialo schedules checks, REX/TEE nodes perform the HTTP probe, the on-chain
//! workflow applies a repeated-failure policy, and a confirmed breach can send
//! a capped amount of DevNet RLO to the named beneficiary.
//!
//! No external cron, database, keeper, or oracle is required for the workflow.

use rialo_venus_proc_macro::rialo;

// Policy bounds for guarantee creation.
//
// Declared at module level rather than inside the rialo! program block: the DSL grammar in
// rialo-venus-dsl 0.10.2 accepts `use` and function items inside that block but rejects `const`
// items, so a const there aborts macro parsing with "unexpected token, expected `}`". Module scope
// keeps them visible to the generated code without changing any value.
const MIN_INTERVAL_SECS: u64 = 15;
const MAX_INTERVAL_SECS: u64 = 86_400;
const MAX_FAILURE_THRESHOLD: u64 = 20;
const MAX_PAYOUTS: u64 = 100;
const MAX_SERVICE_NAME_LEN: usize = 96;
const MAX_URL_LEN: usize = 512;
const MAX_FRAGMENT_LEN: usize = 128;

rialo! {
    workflow {
        state {
            service_name: String,
            endpoint_url: String,
            expected_fragment: String,
            owner: Pubkey,
            beneficiary: Pubkey,

            check_interval_secs: u64,
            failure_threshold: u64,
            compensation_kelvin: u64,
            max_payouts: u64,

            monitoring_active: bool,
            incident_open: bool,
            current_incident_paid: bool,
            consecutive_failures: u64,

            checks_performed: u64,
            healthy_checks: u64,
            failed_checks: u64,
            incidents_opened: u64,
            recoveries: u64,
            payouts_made: u64,
            payout_failures: u64,
            total_compensated_kelvin: u64,

            last_check_timestamp: u64,
            last_breach_timestamp: u64,
            last_recovery_timestamp: u64,
            last_payout_attempt_timestamp: u64,
            next_check_timestamp: u64,
            last_http_status: u64,
            last_body_bytes: u64,
            last_result: String,
        }

        rex {
            // Probe one public HTTPS endpoint inside REX.
            //
            // A successful health observation requires HTTP 2xx and, when a
            // fragment is configured, that fragment to occur in the body.
            // The workflow receives only a compact public-safe observation.
            pub fn probe(url: String, expected_fragment: String) -> Result<String, String> {
                if !url.starts_with("https://") {
                    return Err("https-required".to_string());
                }

                let response = rialo::rex_component::http::get(&url, &[], 10_000)
                    .map_err(|e| format!("http-get-failed:{e}"))?;

                let status = response.status as u64;
                let body_len = response.body.len() as u64;
                let body_text = String::from_utf8_lossy(&response.body);
                let status_ok = (200..300).contains(&response.status);
                let content_ok = expected_fragment.is_empty()
                    || body_text.contains(&expected_fragment);

                if status_ok && content_ok {
                    Ok(format!("HEALTHY|{status}|{body_len}"))
                } else {
                    Ok(format!("UNHEALTHY|{status}|{body_len}"))
                }
            }
        }

        program {
            use rialo_s_program::{
                entrypoint::ProgramResult,
                msg,
                program::invoke,
                pubkey::Pubkey,
                system_instruction,
            };
            use rialo_rex_processor_interface::state::RexReport;
            use rialo_s_program_error::ProgramError;
            use rialo_types::RexOutput;

            // Start one provider-funded service guarantee.
            initiating fn create_guarantee(
                &mut self,
                service_name: String,
                endpoint_url: String,
                expected_fragment: String,
                beneficiary: Pubkey,
                check_interval_secs: u64,
                failure_threshold: u64,
                compensation_kelvin: u64,
                max_payouts: u64,
            ) -> ProgramResult {
                msg!("UptimeSure::CreateGuarantee service={}", service_name);

                if service_name.is_empty()
                    || service_name.len() > MAX_SERVICE_NAME_LEN
                    || endpoint_url.is_empty()
                    || endpoint_url.len() > MAX_URL_LEN
                    || expected_fragment.len() > MAX_FRAGMENT_LEN
                    || !self.endpoint_allowed(&endpoint_url)
                    || !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&check_interval_secs)
                    || failure_threshold < 2
                    || failure_threshold > MAX_FAILURE_THRESHOLD
                    || max_payouts == 0
                    || max_payouts > MAX_PAYOUTS
                {
                    return Err(ProgramError::InvalidArgument);
                }

                self.service_name = service_name;
                self.endpoint_url = endpoint_url;
                self.expected_fragment = expected_fragment;
                self.owner = *self.payer_account().key;
                self.beneficiary = beneficiary;
                self.check_interval_secs = check_interval_secs;
                self.failure_threshold = failure_threshold;
                self.compensation_kelvin = compensation_kelvin;
                self.max_payouts = max_payouts;

                self.monitoring_active = true;
                self.incident_open = false;
                self.current_incident_paid = false;
                self.consecutive_failures = 0;
                self.checks_performed = 0;
                self.healthy_checks = 0;
                self.failed_checks = 0;
                self.incidents_opened = 0;
                self.recoveries = 0;
                self.payouts_made = 0;
                self.payout_failures = 0;
                self.total_compensated_kelvin = 0;
                self.last_check_timestamp = 0;
                self.last_breach_timestamp = 0;
                self.last_recovery_timestamp = 0;
                self.last_payout_attempt_timestamp = 0;
                self.last_http_status = 0;
                self.last_body_bytes = 0;
                self.last_result = "ACTIVE".to_string();

                self.next_check_timestamp = self.now_unix_secs() + self.check_interval_secs;
                let next = self.next_check_timestamp;
                msg!("UptimeSure::NextCheck {}", next);
                AFTER next CALL [execute_scheduled_check];

                Ok(())
            }

            // Timer callback. It asks REX to perform the real HTTP observation.
            handler fn execute_scheduled_check(&mut self) -> ProgramResult {
                if !self.monitoring_active {
                    msg!("UptimeSure::MonitoringPaused");
                    return Ok(());
                }

                let url = self.endpoint_url.clone();
                let fragment = self.expected_fragment.clone();
                let beneficiary = self.beneficiary;
                msg!("UptimeSure::Probe {}", url);

                AFTER report = [probe url: &url expected_fragment: &fragment]
                    CALL [handle_scheduled_probe beneficiary: beneficiary report: report];

                Ok(())
            }

            // Apply a scheduled REX report, settle a newly confirmed breach,
            // then arm the next timer without trying to catch up missed ticks.
            handler fn handle_scheduled_probe(
                &mut self,
                beneficiary: Pubkey,
                report: RexReport,
            ) -> ProgramResult {
                if beneficiary != self.beneficiary {
                    return Err(ProgramError::InvalidArgument);
                }

                self.apply_probe_report(beneficiary, &report)?;

                if self.monitoring_active {
                    self.next_check_timestamp =
                        (self.next_check_timestamp + self.check_interval_secs)
                            .max(self.now_unix_secs() + self.check_interval_secs);
                    let next = self.next_check_timestamp;
                    msg!("UptimeSure::NextCheck {}", next);
                    AFTER next CALL [execute_scheduled_check];
                }

                Ok(())
            }

            // Owner-only immediate probe. This does not create an extra timer;
            // the existing scheduled cadence remains authoritative.
            control fn run_check_now(&mut self) -> ProgramResult {
                self.require_owner()?;
                let url = self.endpoint_url.clone();
                let fragment = self.expected_fragment.clone();
                let beneficiary = self.beneficiary;

                AFTER report = [probe url: &url expected_fragment: &fragment]
                    CALL [handle_manual_probe beneficiary: beneficiary report: report];
                Ok(())
            }

            handler fn handle_manual_probe(
                &mut self,
                beneficiary: Pubkey,
                report: RexReport,
            ) -> ProgramResult {
                if beneficiary != self.beneficiary {
                    return Err(ProgramError::InvalidArgument);
                }
                self.apply_probe_report(beneficiary, &report)
            }

            // Pause future monitoring. An already registered callback may still
            // arrive, but it will not arm another timer while paused.
            control fn pause_monitoring(&mut self) -> ProgramResult {
                self.require_owner()?;
                self.monitoring_active = false;
                self.last_result = "PAUSED".to_string();
                msg!("UptimeSure::Paused");
                Ok(())
            }

            // Resume from now instead of replaying a missed timer backlog.
            control fn resume_monitoring(&mut self) -> ProgramResult {
                self.require_owner()?;
                if self.monitoring_active {
                    return Ok(());
                }
                self.monitoring_active = true;
                self.last_result = "ACTIVE".to_string();
                self.next_check_timestamp = self.now_unix_secs() + self.check_interval_secs;
                let next = self.next_check_timestamp;
                AFTER next CALL [execute_scheduled_check];
                msg!("UptimeSure::Resumed next={}", next);
                Ok(())
            }

            control fn set_check_interval(&mut self, interval_secs: u64) -> ProgramResult {
                self.require_owner()?;
                if !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&interval_secs) {
                    return Err(ProgramError::InvalidArgument);
                }
                self.check_interval_secs = interval_secs;
                msg!("UptimeSure::Interval {}", interval_secs);
                Ok(())
            }

            // Retry settlement for the currently open, unpaid incident.
            control fn retry_current_payout(&mut self, beneficiary: Pubkey) -> ProgramResult {
                self.require_owner()?;
                if beneficiary != self.beneficiary || !self.incident_open || self.current_incident_paid {
                    return Err(ProgramError::InvalidArgument);
                }
                self.try_settle_incident(beneficiary)
            }

            control fn get_status(&mut self) -> ProgramResult {
                msg!("UptimeSure::Status service={} active={} result={}",
                    self.service_name, self.monitoring_active, self.last_result);
                msg!("checks={} healthy={} failed={} consecutive_failures={}",
                    self.checks_performed, self.healthy_checks, self.failed_checks,
                    self.consecutive_failures);
                msg!("incidents={} recoveries={} payouts={} payout_failures={}",
                    self.incidents_opened, self.recoveries, self.payouts_made,
                    self.payout_failures);
                Ok(())
            }

            control fn shutdown(&mut self) -> ProgramResult {
                self.require_owner()?;
                self.monitoring_active = false;
                self.last_result = "SHUTDOWN".to_string();
                self.stop()
            }

            terminating fn stop(&mut self) -> ProgramResult {
                msg!("UptimeSure::Stopped service={}", self.service_name);
                Ok(())
            }

            fn apply_probe_report(
                &mut self,
                beneficiary: Pubkey,
                report: &RexReport,
            ) -> ProgramResult {
                let mut healthy_votes = 0u64;
                let mut unhealthy_votes = 0u64;
                let mut observed_status = 0u64;
                let mut observed_body_bytes = 0u64;

                for output in report.outputs() {
                    match output {
                        RexOutput::Success(response) => {
                            if let Some(raw) = response.response.as_raw() {
                                if let Ok(text) = core::str::from_utf8(raw) {
                                    let mut parts = text.split('|');
                                    let verdict = parts.next().unwrap_or("UNHEALTHY");
                                    let status = parts.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
                                    let bytes = parts.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
                                    if observed_status == 0 {
                                        observed_status = status;
                                        observed_body_bytes = bytes;
                                    }
                                    if verdict == "HEALTHY" {
                                        healthy_votes += 1;
                                    } else {
                                        unhealthy_votes += 1;
                                    }
                                } else {
                                    unhealthy_votes += 1;
                                }
                            } else {
                                unhealthy_votes += 1;
                            }
                        }
                        RexOutput::RexError(err) => {
                            msg!("UptimeSure::RexError {}", err);
                            unhealthy_votes += 1;
                        }
                        RexOutput::UnserializableResponse(err) => {
                            msg!("UptimeSure::Unserializable {}", err);
                            unhealthy_votes += 1;
                        }
                        _ => {}
                    }
                }

                self.checks_performed += 1;
                self.last_check_timestamp = self.now_unix_secs();
                self.last_http_status = observed_status;
                self.last_body_bytes = observed_body_bytes;

                // Fail closed: empty/tied reports are unhealthy. A single node
                // cannot outvote the rest of the report.
                let healthy = healthy_votes > unhealthy_votes && healthy_votes > 0;

                if healthy {
                    self.healthy_checks += 1;
                    self.consecutive_failures = 0;
                    self.last_result = "HEALTHY".to_string();

                    if self.incident_open {
                        self.incident_open = false;
                        self.current_incident_paid = false;
                        self.recoveries += 1;
                        self.last_recovery_timestamp = self.last_check_timestamp;
                        self.last_result = "RECOVERED".to_string();
                        msg!("UptimeSure::Recovered");
                    }
                    return Ok(());
                }

                self.failed_checks += 1;
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.last_result = "UNHEALTHY".to_string();

                if self.consecutive_failures >= self.failure_threshold && !self.incident_open {
                    self.incident_open = true;
                    self.current_incident_paid = false;
                    self.incidents_opened += 1;
                    self.last_breach_timestamp = self.last_check_timestamp;
                    self.last_result = "BREACH_CONFIRMED".to_string();
                    msg!("UptimeSure::BreachConfirmed failures={}", self.consecutive_failures);
                }

                if self.incident_open
                    && !self.current_incident_paid
                    && self.payouts_made < self.max_payouts
                    && self.compensation_kelvin > 0
                {
                    self.try_settle_incident(beneficiary)?;
                }

                Ok(())
            }

            // Settlement deliberately catches CPI failure instead of failing
            // the whole health callback. That keeps breach evidence and future
            // monitoring alive even if the provider-funded payer is empty.
            fn try_settle_incident(&mut self, beneficiary: Pubkey) -> ProgramResult {
                if beneficiary != self.beneficiary
                    || !self.incident_open
                    || self.current_incident_paid
                    || self.payouts_made >= self.max_payouts
                    || self.compensation_kelvin == 0
                {
                    return Ok(());
                }

                self.last_payout_attempt_timestamp = self.now_unix_secs();
                let beneficiary_ai = WriteAccountInfo::from(beneficiary);
                let payer_ai = self.payer_account();
                let sys_ai = &self.accounts[self.program_rialo_s_program__system_program_index];
                let ix = system_instruction::transfer(
                    payer_ai.key,
                    beneficiary_ai.key,
                    self.compensation_kelvin,
                );

                match invoke(&ix, &[payer_ai.clone(), beneficiary_ai.clone(), sys_ai.clone()]) {
                    Ok(()) => {
                        self.current_incident_paid = true;
                        self.payouts_made += 1;
                        self.total_compensated_kelvin = self.total_compensated_kelvin
                            .saturating_add(self.compensation_kelvin);
                        self.last_result = "BREACH_PAID".to_string();
                        msg!("UptimeSure::Payout amount={} beneficiary={}",
                            self.compensation_kelvin, beneficiary);
                    }
                    Err(err) => {
                        self.payout_failures += 1;
                        self.last_result = "BREACH_PAYOUT_FAILED".to_string();
                        msg!("UptimeSure::PayoutFailed {:?}", err);
                    }
                }

                Ok(())
            }

            fn require_owner(&self) -> ProgramResult {
                if *self.payer_account().key != self.owner {
                    msg!("UptimeSure::Unauthorized");
                    return Err(ProgramError::InvalidArgument);
                }
                Ok(())
            }

            // Reject obvious local/private destinations before a workflow is
            // created. This is defense-in-depth; production deployments must
            // additionally rely on REX egress policy/DNS controls against DNS
            // rebinding.
            fn endpoint_allowed(&self, url: &str) -> bool {
                let lower = url.to_ascii_lowercase();
                if !lower.starts_with("https://") {
                    return false;
                }
                let authority = lower[8..].split('/').next().unwrap_or("");
                let host = authority.split('@').last().unwrap_or("").split(':').next().unwrap_or("");
                if host.is_empty()
                    || host == "localhost"
                    || host.ends_with(".localhost")
                    || host.starts_with("127.")
                    || host.starts_with("0.")
                    || host.starts_with("10.")
                    || host.starts_with("192.168.")
                    || host.starts_with("169.254.")
                    || host == "::1"
                    || host.starts_with("fc")
                    || host.starts_with("fd")
                    || host.starts_with("fe80")
                {
                    return false;
                }
                if host.starts_with("172.") {
                    if let Some(second) = host.split('.').nth(1).and_then(|v| v.parse::<u16>().ok()) {
                        if (16..=31).contains(&second) {
                            return false;
                        }
                    }
                }
                true
            }

            // Rialo's clock has appeared in both seconds and milliseconds in
            // public examples. Normalize it before using absolute AFTER times.
            fn now_unix_secs(&self) -> u64 {
                let ts = self.unix_timestamp() as u64;
                if ts > 100_000_000_000 { ts / 1000 } else { ts }
            }
        }
    }
}
