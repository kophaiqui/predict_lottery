"use client";

import type {
  BudgetState,
  CrawlQualityReport,
  ManualFeedbackEntry,
  ModelVersionSnapshot,
  PatternPerformanceStat,
  RollingBacktestResult,
} from "@/app/lib/types";

export function AdvancedAnalyticsPanel(props: {
  active: boolean;
  rollingBacktest: RollingBacktestResult | null;
  qualityReport: CrawlQualityReport;
  modelVersionSnapshot: ModelVersionSnapshot;
  budgetTracker: BudgetState;
  feedbackEntries: ManualFeedbackEntry[];
  feedbackReason: ManualFeedbackEntry["reason"];
  feedbackNote: string;
  selectedCoverageSummary: string;
  performanceLines: Array<[string, PatternPerformanceStat]>;
  onSaveAnalytics: () => void;
  onBudgetPerRoundChange: (value: number) => void;
  onTicketPriceChange: (value: number) => void;
  onFeedbackReasonChange: (value: ManualFeedbackEntry["reason"]) => void;
  onFeedbackNoteChange: (value: string) => void;
  onAddFeedback: () => void;
}) {
  if (!props.active) return null;

  return (
    <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Nang cao</h2>
          <p className="mt-1 text-sm text-slate-400">
            Rolling backtest, baseline comparison, coverage, data quality, budget, versions và feedback.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onSaveAnalytics}
          className="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
        >
          Lưu analytics
        </button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Rolling Backtest</div>
          <div className="mt-2 text-sm leading-6 text-slate-200">
            {props.rollingBacktest ? props.rollingBacktest.summary : "Chưa đủ dữ liệu."}
          </div>
          {props.rollingBacktest && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">
                <div className="text-xs text-slate-400">modelAvg</div>
                <div className="mt-1 font-semibold text-white">{props.rollingBacktest.modelAverageMatch}</div>
              </div>
              <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">
                <div className="text-xs text-slate-400">randomAvg</div>
                <div className="mt-1 font-semibold text-white">{props.rollingBacktest.randomAverageMatch}</div>
              </div>
              <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">
                <div className="text-xs text-slate-400">edge</div>
                <div className="mt-1 font-semibold text-white">{props.rollingBacktest.edge}</div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Random Baseline</div>
          <div className="mt-2 text-sm leading-6 text-slate-200">So sánh model với random baseline để phát hiện overfitting.</div>
          <div className="mt-3 rounded-xl border border-white/8 bg-slate-900/60 p-3 text-sm text-slate-300">
            {props.rollingBacktest?.warnings.length
              ? props.rollingBacktest.warnings.join(" ")
              : "Model đang vượt baseline hoặc chưa có kết luận."}
          </div>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Coverage Analysis</div>
          <div className="mt-2 text-sm leading-6 text-slate-200">{props.selectedCoverageSummary}</div>
          <div className="mt-3 rounded-xl border border-white/8 bg-slate-900/60 p-3 text-sm text-slate-300">
            {props.rollingBacktest ? `Hit distribution: ${JSON.stringify(props.rollingBacktest.hitDistribution)}` : "Chưa có prediction."}
          </div>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Pattern Performance</div>
          <div className="mt-2 space-y-2">
            {props.performanceLines.map(([name, stat]) => (
              <div key={name} className="rounded-xl border border-white/8 bg-slate-900/60 p-3 text-sm text-slate-300">
                <div className="flex items-center justify-between">
                  <span>{name}</span>
                  <span className={stat.edge >= 0 ? "text-emerald-300" : "text-rose-300"}>
                    edge {stat.edge}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  used {stat.usedCount}, avgMatch {stat.avgMatch}, random {stat.randomBaseline}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Data Quality Logs</div>
          <div className="mt-2 text-sm leading-6 text-slate-200">{props.qualityReport.accepted ? "Dữ liệu hợp lệ." : "Dữ liệu bị chặn."}</div>
          <div className="mt-3 space-y-2">
            {props.qualityReport.issues.slice(0, 4).map((entry) => (
              <div key={`${entry.code}-${entry.message}`} className="rounded-xl border border-white/8 bg-slate-900/60 p-3 text-sm text-slate-300">
                <span className="font-semibold text-white">{entry.severity}</span> {entry.message}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Budget / ROI</div>
          <div className="mt-3 grid gap-2 text-sm text-slate-300">
            <label>
              Budget/round
              <input
                type="number"
                value={props.budgetTracker.budgetPerRound}
                onChange={(event) => props.onBudgetPerRoundChange(Number(event.target.value))}
                className="mt-1 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none"
              />
            </label>
            <label>
              Ticket price
              <input
                type="number"
                value={props.budgetTracker.ticketPrice}
                onChange={(event) => props.onTicketPriceChange(Number(event.target.value))}
                className="mt-1 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none"
              />
            </label>
            <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">{`Spent ${props.budgetTracker.totalSpent}, Won ${props.budgetTracker.totalWon}, ROI ${props.budgetTracker.roi}`}</div>
            {props.budgetTracker.warning && (
              <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-amber-100">
                {props.budgetTracker.warning}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Model Versions</div>
          <div className="mt-2 text-sm text-slate-300">
            <div>Model: {props.modelVersionSnapshot.modelVersion}</div>
            <div>Algorithm: {props.modelVersionSnapshot.algorithmVersion}</div>
            <div>Generated: {props.modelVersionSnapshot.generatedAt.slice(0, 10)}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Manual Feedback</div>
          <div className="mt-3 grid gap-2 text-sm text-slate-300">
            <select
              value={props.feedbackReason}
              onChange={(event) => props.onFeedbackReasonChange(event.target.value as ManualFeedbackEntry["reason"])}
              className="rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none"
            >
              <option value="score-high">score-high</option>
              <option value="coverage-good">coverage-good</option>
              <option value="manual">manual</option>
              <option value="gut-feel">gut-feel</option>
              <option value="pattern-specific">pattern-specific</option>
            </select>
            <textarea
              value={props.feedbackNote}
              onChange={(event) => props.onFeedbackNoteChange(event.target.value)}
              className="min-h-24 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none"
            />
            <button
              type="button"
              onClick={props.onAddFeedback}
              className="rounded-xl bg-white px-4 py-2 font-semibold text-slate-950"
            >
              Lưu feedback
            </button>
            <div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">
              {props.feedbackEntries.length
                ? props.feedbackEntries.map((entry) => `${entry.reason}: ${entry.note}`).join(" | ")
                : "Chưa có feedback."}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
