import { round } from "./number-utils";
import type { BudgetState, PredictionSet } from "./types";

export function createBudgetState(params?: {
  budgetPerRound?: number;
  ticketPrice?: number;
  totalSpent?: number;
  totalWon?: number;
}): BudgetState {
  const budgetPerRound = params?.budgetPerRound ?? 100000;
  const ticketPrice = params?.ticketPrice ?? 10000;
  const totalSpent = params?.totalSpent ?? 0;
  const totalWon = params?.totalWon ?? 0;
  const profit = totalWon - totalSpent;
  return {
    budgetPerRound,
    ticketPrice,
    maxSetsPerRound: Math.max(1, Math.floor(budgetPerRound / ticketPrice)),
    totalSpent,
    totalWon,
    profit,
    roi: totalSpent > 0 ? round(profit / totalSpent, 3) : 0,
    warning: totalSpent > budgetPerRound ? "Vượt ngân sách cho kỳ này." : null,
  };
}

export function simulateBudgetRound(params: {
  budget: BudgetState;
  selectedSets: PredictionSet[];
  prizeAmounts: number[];
}): BudgetState {
  const spent = Math.min(params.selectedSets.length, params.budget.maxSetsPerRound) * params.budget.ticketPrice;
  const won = params.prizeAmounts.reduce((total, amount) => total + amount, 0);
  return createBudgetState({
    budgetPerRound: params.budget.budgetPerRound,
    ticketPrice: params.budget.ticketPrice,
    totalSpent: params.budget.totalSpent + spent,
    totalWon: params.budget.totalWon + won,
  });
}

export function budgetSummary(budget: BudgetState): string {
  return `Đã chi ${budget.totalSpent}, đã trúng ${budget.totalWon}, ROI ${budget.roi}`;
}
