import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceNowClient } from "../../servicenow/client.js";
import { type Pack, toolResult, jsonResult, errorResult } from "../types.js";

export class TroubleshootingPack implements Pack {
  name = "troubleshooting";
  description =
    "ServiceNow instance health & performance — diagnostics, slow queries, logs, semaphores, active transactions, and comprehensive performance analysis";

  register(server: McpServer, client: ServiceNowClient): void {
    this.registerInstanceHealth(server, client);
    this.registerSlowQueries(server, client);
    this.registerSystemLogs(server, client);
    this.registerSchedulerHealth(server, client);
    this.registerTableStats(server, client);
    this.registerSemaphores(server, client);
    this.registerDiagnosePerformance(server, client);
    this.registerLoginIssues(server, client);
    this.registerNodeLogs(server, client);
    this.registerCacheStats(server, client);
  }

  // ── Instance Health Check ────────────────────────────────────────────

  private registerInstanceHealth(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_instance_health",
      `Comprehensive ServiceNow instance health check.
Checks: node status, active transactions, scheduler workers, semaphore usage, recent errors, and system properties related to performance.

When the instance is slow, start here to get a full picture.
Common causes of instance slowness:
1. Long-running transactions blocking threads
2. Semaphore exhaustion (too many concurrent operations)
3. Scheduler worker thread starvation
4. Memory pressure (JVM heap)
5. Slow database queries
6. Excessive logging
7. Poorly written business rules/scripts on high-volume tables
8. Large data exports/imports running in foreground`,
      {
        include_properties: z.boolean().optional().describe("Include performance-related system properties (default: true)"),
      },
      async (args) => {
        try {
          const results: Record<string, unknown> = {};

          // 1. Check system nodes
          const nodes = await client.getRecords("sys_cluster_state", {
            sysparm_fields: "sys_id,system_id,status,node_id,schedulers,stats",
            sysparm_limit: 20,
            sysparm_display_value: "true",
          });
          results.cluster_nodes = { count: nodes.length, nodes };

          // 2. Check recent errors (last 1 hour)
          const oneHourAgo = new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace("T", " ");
          const errors = await client.getRecords("syslog", {
            sysparm_query: `level=0^ORlevel=1^sys_created_on>${oneHourAgo}^ORDERBYDESCsys_created_on`,
            sysparm_fields: "sys_id,level,message,source,sys_created_on",
            sysparm_limit: 20,
          });
          results.recent_errors = { count: errors.length, errors: errors.slice(0, 10) };

          // 3. Check active transactions count
          const activeTx = await client.getRecords("syslog_transaction", {
            sysparm_query: `sys_created_on>${oneHourAgo}^response_time>5000^ORDERBYDESCresponse_time`,
            sysparm_fields: "sys_id,url,response_time,sys_created_on",
            sysparm_limit: 10,
          });
          results.slow_transactions_last_hour = { count: activeTx.length, transactions: activeTx };

          // 4. Check scheduled job health
          const stuckJobs = await client.getRecords("sys_trigger", {
            sysparm_query: "state=1^sys_updated_on<javascript:gs.minutesAgo(30)",
            sysparm_fields: "sys_id,name,state,claimed_by,sys_updated_on",
            sysparm_limit: 20,
            sysparm_display_value: "true",
          });
          results.potentially_stuck_jobs = { count: stuckJobs.length, jobs: stuckJobs };

          // 5. Performance-related properties
          if (args.include_properties !== false) {
            const perfProps = [
              "glide.ui.session_timeout",
              "glide.sys.session_timeout",
              "glide.db.max_idle_transactions",
              "glide.scheduler.worker.threads",
              "glide.processor.max.threads",
              "glide.db.pool.size",
              "com.glide.ui.max_row_count",
            ];
            const properties: Record<string, unknown> = {};
            for (const prop of perfProps) {
              try {
                const propRecords = await client.getRecords("sys_properties", {
                  sysparm_query: `name=${prop}`,
                  sysparm_fields: "name,value",
                  sysparm_limit: 1,
                });
                if (propRecords.length > 0) {
                  properties[prop] = propRecords[0].value;
                }
              } catch {
                // Skip inaccessible properties
              }
            }
            results.performance_properties = properties;
          }

          // 6. Generate health summary
          const issues: string[] = [];
          if (errors.length > 10) issues.push(`High error rate: ${errors.length} errors in the last hour`);
          if (activeTx.length > 0) issues.push(`${activeTx.length} slow transactions (>5s) in the last hour`);
          if (stuckJobs.length > 0) issues.push(`${stuckJobs.length} potentially stuck scheduled jobs`);

          const healthStatus = issues.length === 0 ? "HEALTHY" : issues.length < 3 ? "WARNING" : "CRITICAL";
          results.health_summary = {
            status: healthStatus,
            issues: issues.length > 0 ? issues : ["No issues detected"],
            recommendation:
              healthStatus === "CRITICAL"
                ? "Immediate investigation required. Start with slow transactions and stuck jobs."
                : healthStatus === "WARNING"
                  ? "Monitor closely. Check the identified issues."
                  : "Instance appears healthy. Continue regular monitoring.",
          };

          return jsonResult(results, `Instance Health: ${healthStatus}`);
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Slow Queries ─────────────────────────────────────────────────────

  private registerSlowQueries(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_slow_queries",
      `Analyze slow database queries and transactions in ServiceNow.
Queries syslog_transaction for long-running requests.
Common causes of slow queries:
1. Missing database indexes on frequently queried fields.
2. CONTAINS queries (use STARTSWITH instead — CONTAINS triggers full table scans).
3. GlideRecord without setLimit() on large tables.
4. Dot-walking through multiple reference fields.
5. Large ACL evaluations on tables with many rows.
6. getRowCount() on large result sets (use GlideAggregate).`,
      {
        threshold_ms: z.number().optional().describe("Response time threshold in ms (default: 5000)"),
        hours: z.number().optional().describe("Look back period in hours (default: 1)"),
        url_filter: z.string().optional().describe("Filter by URL pattern (e.g. 'incident' for incident-related transactions)"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          const threshold = args.threshold_ms || 5000;
          const hours = args.hours || 1;
          const lookback = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19).replace("T", " ");

          let query = `sys_created_on>${lookback}^response_time>${threshold}^ORDERBYDESCresponse_time`;
          if (args.url_filter) {
            query += `^urlLIKE${args.url_filter}`;
          }

          const records = await client.getRecords("syslog_transaction", {
            sysparm_query: query,
            sysparm_fields: "sys_id,url,response_time,sys_created_by,sys_created_on",
            sysparm_limit: args.limit || 30,
          });

          // Group by URL pattern
          const urlCounts: Record<string, { count: number; avg_time: number; max_time: number }> = {};
          for (const r of records) {
            const url = String(r.url || "").split("?")[0]; // Remove query params
            if (!urlCounts[url]) urlCounts[url] = { count: 0, avg_time: 0, max_time: 0 };
            urlCounts[url].count++;
            const time = Number(r.response_time) || 0;
            urlCounts[url].avg_time += time;
            urlCounts[url].max_time = Math.max(urlCounts[url].max_time, time);
          }
          for (const url of Object.keys(urlCounts)) {
            urlCounts[url].avg_time = Math.round(urlCounts[url].avg_time / urlCounts[url].count);
          }

          const analysis = {
            total_slow_transactions: records.length,
            threshold_ms: threshold,
            period_hours: hours,
            top_slow_urls: Object.entries(urlCounts)
              .sort(([, a], [, b]) => b.max_time - a.max_time)
              .slice(0, 10)
              .map(([url, stats]) => ({ url, ...stats })),
            raw_transactions: records.slice(0, 20),
            recommendations: [
              "Check if slow URLs correspond to list views with missing indexes",
              "Look for business rules on the affected tables that might be causing overhead",
              "Check for CONTAINS queries — replace with STARTSWITH where possible",
              "Review ACLs on the affected tables for script-based rules",
              "Consider adding database indexes for frequently queried fields",
            ],
          };

          return jsonResult(analysis, `Found ${records.length} slow transactions (>${threshold}ms) in the last ${hours}h`);
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── System Logs ──────────────────────────────────────────────────────

  private registerSystemLogs(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_system_logs",
      `Query ServiceNow system logs (syslog) for troubleshooting.
Actions: errors, warnings, search, by_source.
Log levels: 0=Error, 1=Warning, 2=Info, 3=Debug.
Best practices:
- Start with errors (level=0) when diagnosing issues.
- Filter by source to focus on specific components.
- Use time-based filtering to narrow down when issues started.
- Check for recurring error patterns that indicate systemic issues.
- Monitor for 'Transaction cancelled' messages (indicates timeouts).`,
      {
        action: z.enum(["errors", "warnings", "search", "by_source"]),
        hours: z.number().optional().describe("Look back period in hours (default: 1)"),
        source: z.string().optional().describe("Log source filter"),
        search_term: z.string().optional().describe("Text to search for in log messages"),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          const hours = args.hours || 1;
          const lookback = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19).replace("T", " ");
          let query = `sys_created_on>${lookback}`;

          switch (args.action) {
            case "errors":
              query += "^level=0";
              break;
            case "warnings":
              query += "^level=0^ORlevel=1";
              break;
            case "search":
              if (!args.search_term) return errorResult("search_term required for search action");
              query += `^messageLIKE${args.search_term}`;
              break;
            case "by_source":
              if (!args.source) return errorResult("source required for by_source action");
              query += `^source=${args.source}`;
              break;
          }

          if (args.query) query += `^${args.query}`;
          query += "^ORDERBYDESCsys_created_on";

          const records = await client.getRecords("syslog", {
            sysparm_query: query,
            sysparm_fields: "sys_id,level,source,message,sys_created_on,sys_created_by",
            sysparm_limit: args.limit || 50,
          });

          // Analyze error patterns
          const patterns: Record<string, number> = {};
          for (const r of records) {
            const msg = String(r.message || "").substring(0, 100);
            patterns[msg] = (patterns[msg] || 0) + 1;
          }

          const topPatterns = Object.entries(patterns)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([message, count]) => ({ message, count }));

          return jsonResult(
            { total: records.length, top_patterns: topPatterns, logs: records.slice(0, 30) },
            `Found ${records.length} log entries (${args.action}) in the last ${hours}h`
          );
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Scheduler Health ─────────────────────────────────────────────────

  private registerSchedulerHealth(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_scheduler_health",
      `Check ServiceNow scheduler worker thread health.
Actions: running_jobs, stuck_jobs, worker_status, queue_depth.
Common scheduler issues:
1. Worker threads exhausted — all threads busy with long-running jobs.
2. Stuck jobs — jobs that have been running for an abnormally long time.
3. Queue buildup — more jobs queued than workers can process.
4. Thundering herd — too many jobs scheduled at the same time.
Solutions: stagger job schedules, increase worker threads, fix long-running scripts.`,
      {
        action: z.enum(["running_jobs", "stuck_jobs", "worker_status", "queue_depth"]),
        minutes_stuck: z.number().optional().describe("Minutes after which a job is considered stuck (default: 30)"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "running_jobs": {
              const records = await client.getRecords("sys_trigger", {
                sysparm_query: "state=1^ORDERBYsys_updated_on",
                sysparm_fields: "sys_id,name,state,claimed_by,system_id,trigger_type,next_action,sys_updated_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `${records.length} jobs currently running`);
            }
            case "stuck_jobs": {
              const minutes = args.minutes_stuck || 30;
              const cutoff = new Date(Date.now() - minutes * 60000).toISOString().slice(0, 19).replace("T", " ");
              const records = await client.getRecords("sys_trigger", {
                sysparm_query: `state=1^sys_updated_on<${cutoff}^ORDERBYsys_updated_on`,
                sysparm_fields: "sys_id,name,state,claimed_by,system_id,trigger_type,sys_updated_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              const summary =
                records.length > 0
                  ? `ALERT: ${records.length} jobs running for more than ${minutes} minutes. These may be stuck and consuming scheduler worker threads.`
                  : `No stuck jobs found (threshold: ${minutes} minutes).`;
              return jsonResult(
                {
                  summary,
                  stuck_jobs: records,
                  recommended_actions: records.length > 0
                    ? [
                        "Review each stuck job to understand why it's taking long",
                        "Check if the job script has an infinite loop or missing break condition",
                        "Consider restarting the job by cancelling and re-scheduling",
                        "If persistent, check for database locks or external dependency issues",
                      ]
                    : [],
                },
                summary
              );
            }
            case "worker_status": {
              // Check scheduler worker thread configuration
              const workerProp = await client.getRecords("sys_properties", {
                sysparm_query: "name=glide.scheduler.worker.threads",
                sysparm_fields: "name,value",
                sysparm_limit: 1,
              });
              const running = await client.getRecords("sys_trigger", {
                sysparm_query: "state=1",
                sysparm_fields: "sys_id",
                sysparm_limit: 200,
              });
              const workerThreads = workerProp.length > 0 ? Number(workerProp[0].value) || 0 : 0;
              const utilization = workerThreads > 0 ? Math.round((running.length / workerThreads) * 100) : 0;
              return jsonResult(
                {
                  configured_workers: workerThreads || "Unknown (check glide.scheduler.worker.threads)",
                  active_jobs: running.length,
                  utilization_pct: utilization,
                  status: utilization > 80 ? "HIGH" : utilization > 50 ? "MODERATE" : "HEALTHY",
                  recommendation:
                    utilization > 80
                      ? "Worker utilization is high. Review running jobs and consider increasing worker thread count."
                      : "Worker utilization is acceptable.",
                },
                `Scheduler workers: ${running.length} active jobs, ${utilization}% utilization`
              );
            }
            case "queue_depth": {
              const ready = await client.getRecords("sys_trigger", {
                sysparm_query: "state=0",
                sysparm_fields: "sys_id",
                sysparm_limit: 500,
              });
              const waiting = await client.getRecords("sys_trigger", {
                sysparm_query: "state=2",
                sysparm_fields: "sys_id",
                sysparm_limit: 500,
              });
              return jsonResult(
                {
                  ready_to_run: ready.length,
                  waiting: waiting.length,
                  total_queued: ready.length + waiting.length,
                  assessment:
                    ready.length > 100
                      ? "HIGH queue depth — jobs are backing up. Check for stuck workers or resource constraints."
                      : "Queue depth is normal.",
                },
                `Scheduler queue: ${ready.length} ready, ${waiting.length} waiting`
              );
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Table Statistics ─────────────────────────────────────────────────

  private registerTableStats(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_table_stats",
      `Check ServiceNow table sizes and rotation status.
Actions: large_tables, table_size, rotation_status.
Best practices:
- Monitor large tables for potential performance impact.
- Enable table rotation for log tables (syslog, syslog_transaction, sys_audit).
- Large custom tables should have appropriate indexes.
- Archive or purge old data from growing tables.
- Table sizes > 10M rows can cause performance issues without proper indexing.`,
      {
        action: z.enum(["large_tables", "table_size", "rotation_status"]),
        table_name: z.string().optional().describe("Table name for table_size action"),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "large_tables": {
              const records = await client.getRecords("sys_table_rotation_schedule", {
                sysparm_query: args.query || "ORDERBYDESCsys_updated_on",
                sysparm_fields: "sys_id,name,table,active,version,retention_policy",
                sysparm_limit: args.limit || 30,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} tables with rotation schedules`);
            }
            case "table_size": {
              if (!args.table_name) return errorResult("table_name required");
              const agg = await client.getAggregate(args.table_name, {
                sysparm_count: "true",
              });
              return jsonResult(
                agg,
                `Table '${args.table_name}' record count. If > 1M rows, ensure proper indexing.`
              );
            }
            case "rotation_status": {
              const records = await client.getRecords("sys_table_rotation_schedule", {
                sysparm_query: "active=true",
                sysparm_fields: "sys_id,name,table,active,version,retention_policy,sys_updated_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              const criticalTables = ["syslog", "syslog_transaction", "sys_audit", "sys_email_log", "ha_log"];
              const configured = records.map((r) => String(r.table || r.name));
              const missing = criticalTables.filter((t) => !configured.some((c) => c.includes(t)));
              return jsonResult(
                {
                  configured_rotations: records,
                  missing_critical_rotations: missing,
                  recommendation:
                    missing.length > 0
                      ? `Missing rotation for critical tables: ${missing.join(", ")}. Configure rotation to prevent unbounded table growth.`
                      : "All critical tables have rotation configured.",
                },
                `${records.length} rotation schedules configured, ${missing.length} critical tables missing rotation`
              );
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Semaphores ───────────────────────────────────────────────────────

  private registerSemaphores(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_semaphores",
      `Check ServiceNow semaphore usage and contention.
Actions: status, waiters.
Semaphores control concurrent access to shared resources.
When semaphores are exhausted, transactions queue up causing slowness.
Common semaphore issues:
1. Too many concurrent users on the same form/list.
2. Long-running business rules holding semaphores.
3. Integrations making too many concurrent API calls.
4. Bulk imports consuming all available semaphores.`,
      {
        action: z.enum(["status", "waiters"]),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "status": {
              const records = await client.getRecords("sys_semaphore", {
                sysparm_query: args.query || "ORDERBYDESCsys_updated_on",
                sysparm_fields: "sys_id,name,count,max_allowed,sys_updated_on",
                sysparm_limit: args.limit || 50,
              });
              const highUsage = records.filter((r) => {
                const count = Number(r.count) || 0;
                const max = Number(r.max_allowed) || 1;
                return count / max > 0.8;
              });
              return jsonResult(
                {
                  total_semaphores: records.length,
                  high_usage: highUsage.length,
                  high_usage_semaphores: highUsage,
                  all_semaphores: records,
                  assessment:
                    highUsage.length > 0
                      ? `WARNING: ${highUsage.length} semaphore(s) at >80% capacity. This can cause transaction queuing.`
                      : "Semaphore usage is within normal limits.",
                },
                `Semaphores: ${highUsage.length} at high usage out of ${records.length} total`
              );
            }
            case "waiters": {
              const records = await client.getRecords("sys_semaphore_group", {
                sysparm_query: args.query || "ORDERBYDESCsys_updated_on",
                sysparm_fields: "sys_id,name,semaphore,waiting_count,sys_updated_on",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(records, `Found ${records.length} semaphore groups with waiter info`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Diagnose Performance (Comprehensive) ─────────────────────────────

  private registerDiagnosePerformance(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_diagnose_performance",
      `Comprehensive performance diagnosis for ServiceNow.
This tool runs multiple checks in sequence and provides a unified analysis.
Use when users report: "the instance is slow", "pages aren't loading", "transactions timing out".

Checks performed:
1. Slow transactions in the last hour
2. Error log spike analysis
3. Scheduler worker utilization
4. Recent long-running background jobs
5. Database table size concerns

Returns a prioritized list of findings and recommended actions.`,
      {
        hours: z.number().optional().describe("Analysis period in hours (default: 2)"),
        focus_area: z
          .enum(["all", "transactions", "errors", "scheduler", "database"])
          .optional()
          .describe("Focus on a specific area (default: all)"),
      },
      async (args) => {
        try {
          const hours = args.hours || 2;
          const lookback = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19).replace("T", " ");
          const focus = args.focus_area || "all";

          const findings: Array<{ severity: string; area: string; finding: string; recommendation: string }> = [];
          const metrics: Record<string, unknown> = {};

          // 1. Slow transactions
          if (focus === "all" || focus === "transactions") {
            const slowTx = await client.getRecords("syslog_transaction", {
              sysparm_query: `sys_created_on>${lookback}^response_time>5000^ORDERBYDESCresponse_time`,
              sysparm_fields: "sys_id,url,response_time,sys_created_by,sys_created_on",
              sysparm_limit: 30,
            });
            metrics.slow_transactions = slowTx.length;

            if (slowTx.length > 20) {
              findings.push({
                severity: "CRITICAL",
                area: "Transactions",
                finding: `${slowTx.length} transactions exceeded 5s in the last ${hours}h`,
                recommendation: "Check the slowest URLs for missing indexes, heavy business rules, or ACL script evaluations.",
              });
            } else if (slowTx.length > 5) {
              findings.push({
                severity: "WARNING",
                area: "Transactions",
                finding: `${slowTx.length} slow transactions detected`,
                recommendation: "Monitor the affected URLs and check for recently changed business rules.",
              });
            }

            // Check for very slow (>30s) transactions
            const verySlow = slowTx.filter((t) => Number(t.response_time) > 30000);
            if (verySlow.length > 0) {
              findings.push({
                severity: "CRITICAL",
                area: "Transactions",
                finding: `${verySlow.length} transactions took >30 seconds`,
                recommendation: "These may be causing session timeouts. Check for runaway GlideRecord queries or infinite loops.",
              });
            }

            metrics.slowest_transactions = slowTx.slice(0, 5).map((t) => ({
              url: t.url,
              response_time_ms: t.response_time,
              user: t.sys_created_by,
            }));
          }

          // 2. Error analysis
          if (focus === "all" || focus === "errors") {
            const errors = await client.getRecords("syslog", {
              sysparm_query: `level=0^sys_created_on>${lookback}`,
              sysparm_fields: "sys_id",
              sysparm_limit: 200,
            });
            const errorsPerHour = Math.round(errors.length / hours);
            metrics.errors_total = errors.length;
            metrics.errors_per_hour = errorsPerHour;

            if (errorsPerHour > 50) {
              findings.push({
                severity: "CRITICAL",
                area: "Errors",
                finding: `${errorsPerHour} errors/hour detected (${errors.length} total in ${hours}h)`,
                recommendation: "High error rate. Use ts_system_logs to identify the top error patterns and sources.",
              });
            } else if (errorsPerHour > 10) {
              findings.push({
                severity: "WARNING",
                area: "Errors",
                finding: `${errorsPerHour} errors/hour detected`,
                recommendation: "Elevated error rate. Review syslog for recurring patterns.",
              });
            }
          }

          // 3. Scheduler health
          if (focus === "all" || focus === "scheduler") {
            const running = await client.getRecords("sys_trigger", {
              sysparm_query: "state=1",
              sysparm_fields: "sys_id,name,sys_updated_on",
              sysparm_limit: 200,
            });
            metrics.running_jobs = running.length;

            const stuckCutoff = new Date(Date.now() - 30 * 60000).toISOString().slice(0, 19).replace("T", " ");
            const stuck = running.filter(
              (j) => j.sys_updated_on && String(j.sys_updated_on) < stuckCutoff
            );
            metrics.potentially_stuck_jobs = stuck.length;

            if (stuck.length > 0) {
              findings.push({
                severity: "WARNING",
                area: "Scheduler",
                finding: `${stuck.length} potentially stuck jobs (running >30min)`,
                recommendation: "Review stuck jobs — they consume scheduler worker threads. Consider cancelling and fixing the underlying scripts.",
              });
            }

            if (running.length > 20) {
              findings.push({
                severity: "WARNING",
                area: "Scheduler",
                finding: `${running.length} concurrent running jobs`,
                recommendation: "High scheduler activity. Check for thundering herd effect (many jobs at same time). Stagger schedules.",
              });
            }
          }

          // 4. Database / heavy tables
          if (focus === "all" || focus === "database") {
            const heavyTables = ["syslog", "sys_audit", "syslog_transaction"];
            for (const table of heavyTables) {
              try {
                const agg = (await client.getAggregate(table, {
                  sysparm_count: "true",
                })) as { result: { stats: { count: string } } };
                const count = parseInt(agg?.result?.stats?.count || "0", 10);
                if (count > 5000000) {
                  findings.push({
                    severity: "WARNING",
                    area: "Database",
                    finding: `Table '${table}' has ${(count / 1000000).toFixed(1)}M rows`,
                    recommendation: `Large table size. Ensure table rotation is configured for '${table}'. Consider archiving old data.`,
                  });
                }
              } catch {
                // Skip tables we can't aggregate
              }
            }
          }

          // Sort findings by severity
          const severityOrder: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
          findings.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));

          const overallStatus = findings.some((f) => f.severity === "CRITICAL")
            ? "CRITICAL"
            : findings.some((f) => f.severity === "WARNING")
              ? "WARNING"
              : "HEALTHY";

          return jsonResult(
            {
              overall_status: overallStatus,
              analysis_period_hours: hours,
              findings_count: findings.length,
              findings,
              metrics,
              next_steps:
                overallStatus === "CRITICAL"
                  ? [
                      "Address CRITICAL findings immediately",
                      "Use ts_slow_queries for detailed transaction analysis",
                      "Use ts_system_logs errors to identify root causes",
                      "Check ts_scheduler_health for stuck workers",
                    ]
                  : overallStatus === "WARNING"
                    ? [
                        "Monitor the WARNING items over the next few hours",
                        "Schedule maintenance to address non-critical findings",
                        "Review recent deployments that may have introduced issues",
                      ]
                    : ["Continue regular monitoring", "No immediate action needed"],
            },
            `Performance Diagnosis: ${overallStatus} — ${findings.length} finding(s)`
          );
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Login Issues ─────────────────────────────────────────────────────

  private registerLoginIssues(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_login_issues",
      `Diagnose ServiceNow login and authentication issues.
Actions: failed_logins, locked_accounts, active_sessions, session_stats.
Common issues:
1. Account lockouts from failed password attempts.
2. SSO/SAML configuration issues.
3. Session timeout too aggressive.
4. MFA failures.
5. LDAP sync issues.`,
      {
        action: z.enum(["failed_logins", "locked_accounts", "active_sessions", "session_stats"]),
        user: z.string().optional().describe("Username to filter by"),
        hours: z.number().optional().describe("Look back period (default: 24)"),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          const hours = args.hours || 24;
          const lookback = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19).replace("T", " ");

          switch (args.action) {
            case "failed_logins": {
              let query = `sys_created_on>${lookback}^statusINfailed,failure^ORDERBYDESCsys_created_on`;
              if (args.user) query += `^user_name=${args.user}`;
              const records = await client.getRecords("sysevent", {
                sysparm_query: `name=login^sys_created_on>${lookback}^parm1=failed`,
                sysparm_fields: "sys_id,name,parm1,parm2,sys_created_on,sys_created_by",
                sysparm_limit: args.limit || 50,
              });

              // Also check syslog for login failures
              let logQuery = `messageLIKElogin failed^ORmessageLIKEauthentication failed^sys_created_on>${lookback}`;
              if (args.user) logQuery += `^messageLIKE${args.user}`;
              const logEntries = await client.getRecords("syslog", {
                sysparm_query: logQuery + "^ORDERBYDESCsys_created_on",
                sysparm_fields: "sys_id,message,source,sys_created_on",
                sysparm_limit: args.limit || 50,
              });

              return jsonResult(
                {
                  login_events: records,
                  log_entries: logEntries,
                  total_failures: records.length + logEntries.length,
                },
                `Found ${records.length + logEntries.length} login failure indicators in the last ${hours}h`
              );
            }
            case "locked_accounts": {
              const records = await client.getRecords("sys_user", {
                sysparm_query: "locked_out=true^active=true",
                sysparm_fields: "sys_id,user_name,first_name,last_name,email,locked_out,failed_attempts,sys_updated_on",
                sysparm_limit: args.limit || 50,
              });
              return jsonResult(records, `Found ${records.length} locked-out active users`);
            }
            case "active_sessions": {
              let query = "status=active^ORDERBYDESCsys_created_on";
              if (args.user) query = `user.user_name=${args.user}^${query}`;
              const records = await client.getRecords("v_user_session", {
                sysparm_query: query,
                sysparm_fields: "sys_id,user,status,ip_address,last_activity,sys_created_on",
                sysparm_limit: args.limit || 50,
                sysparm_display_value: "true",
              });
              return jsonResult(records, `Found ${records.length} active sessions`);
            }
            case "session_stats": {
              const sessionTimeout = await client.getRecords("sys_properties", {
                sysparm_query: "nameLIKEsession_timeout",
                sysparm_fields: "name,value",
                sysparm_limit: 5,
              });
              return jsonResult(
                {
                  session_properties: sessionTimeout,
                  recommendations: [
                    "Default session timeout is 30 minutes (glide.ui.session_timeout)",
                    "If users report frequent logouts, consider increasing the timeout",
                    "For security, keep timeout ≤ 60 minutes for standard users",
                    "Service accounts may need longer timeouts for integrations",
                  ],
                },
                "Session configuration"
              );
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Node Logs ────────────────────────────────────────────────────────

  private registerNodeLogs(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_node_logs",
      `Check ServiceNow application node logs and cluster state.
Actions: node_status, node_stats, thread_dumps.
Use for diagnosing:
- Node failures or restarts
- Memory issues (JVM heap)
- Thread pool exhaustion
- Cluster split-brain scenarios`,
      {
        action: z.enum(["node_status", "node_stats", "thread_dumps"]),
        node_id: z.string().optional().describe("Specific node ID to check"),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "node_status": {
              const records = await client.getRecords("sys_cluster_state", {
                sysparm_query: args.query || "",
                sysparm_fields: "sys_id,system_id,status,node_id,schedulers,most_recent_message,stats,sys_updated_on",
                sysparm_limit: args.limit || 20,
                sysparm_display_value: "true",
              });
              const downNodes = records.filter((r) => r.status !== "online");
              const summary =
                downNodes.length > 0
                  ? `WARNING: ${downNodes.length} node(s) offline: ${downNodes.map((n) => n.system_id).join(", ")}`
                  : `All ${records.length} nodes online`;
              return jsonResult({ summary, nodes: records }, summary);
            }
            case "node_stats": {
              const records = await client.getRecords("sys_cluster_state", {
                sysparm_query: args.node_id ? `system_id=${args.node_id}` : "",
                sysparm_fields: "sys_id,system_id,status,stats,sys_updated_on",
                sysparm_limit: 10,
              });
              return jsonResult(records, `Node statistics for ${records.length} node(s)`);
            }
            case "thread_dumps": {
              // Thread dumps are typically in syslog
              const records = await client.getRecords("syslog", {
                sysparm_query: `messageLIKEthread dump^ORmessageLIKEThread State^ORDERBYDESCsys_created_on`,
                sysparm_fields: "sys_id,message,source,sys_created_on",
                sysparm_limit: args.limit || 10,
              });
              return jsonResult(
                records,
                records.length > 0
                  ? `Found ${records.length} thread dump entries. Review for blocked/deadlocked threads.`
                  : "No recent thread dump entries found in syslog."
              );
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  // ── Cache Statistics ─────────────────────────────────────────────────

  private registerCacheStats(server: McpServer, client: ServiceNowClient): void {
    server.tool(
      "ts_cache_stats",
      `Check ServiceNow cache performance and configuration.
Actions: cache_config, flush_info.
Caching issues can cause:
1. Stale data displayed to users (cache not invalidated).
2. High memory usage from oversized caches.
3. Performance degradation from cache misses on critical tables.
Best practice: Use sys_cache_flush for targeted cache clears, not global flushes.`,
      {
        action: z.enum(["cache_config", "flush_info"]),
        query: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        try {
          switch (args.action) {
            case "cache_config": {
              const records = await client.getRecords("sys_properties", {
                sysparm_query: "nameLIKEcache^ORnameLIKEglide.db.cache",
                sysparm_fields: "sys_id,name,value,description",
                sysparm_limit: args.limit || 30,
              });
              return jsonResult(records, `Found ${records.length} cache-related properties`);
            }
            case "flush_info": {
              const records = await client.getRecords("sys_cache_flush", {
                sysparm_query: args.query || "ORDERBYDESCsys_created_on",
                sysparm_fields: "sys_id,name,table,category,sys_created_on,sys_created_by",
                sysparm_limit: args.limit || 20,
              });
              return jsonResult(records, `Found ${records.length} recent cache flush records`);
            }
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }
}
