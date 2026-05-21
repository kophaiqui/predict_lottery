import type { LotteryConfig, LotteryType } from "./types";

export const LOTTERY_CONFIG: Record<LotteryType, LotteryConfig> = {
  mega645: {
    type: "mega645",
    name: "Mega 6/45",
    sourceUrl: "https://www.vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/mega-645",
    maxNumber: 45,
    pickCount: 6,
    hasBonus: false,
    drawDays: [2, 4, 6],
    sourceFormat: "html",
    resultSelectorMap: {
      date: "regex:NgÃ y quay sá»‘.*?(\\d{2}/\\d{2}/\\d{4})",
      numbers: "regex:(?:\\b\\d{1,2}\\b(?:\\s*[-,;|]\\s*\\b\\d{1,2}\\b){5,})",
      jackpot: "regex:Jackpot.*?(\\d[\\d.,]*)",
      rows: ".table tr",
    },
    notes: "Tá»‘i Æ°u cho nguá»“n HTML hoáº·c API tráº£ vá» báº£ng káº¿t quáº£.",
  },
  power655: {
    type: "power655",
    name: "Power 6/55",
    sourceUrl: "https://www.vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/power-6-55",
    maxNumber: 55,
    pickCount: 6,
    hasBonus: true,
    bonusName: "specialNumber",
    drawDays: [3, 5, 7],
    sourceFormat: "html",
    resultSelectorMap: {
      date: "regex:NgÃ y quay sá»‘.*?(\\d{2}/\\d{2}/\\d{4})",
      numbers: "regex:(?:\\b\\d{1,2}\\b(?:\\s*[-,;|]\\s*\\b\\d{1,2}\\b){5,})",
      specialNumber: "regex:Power 6/55.*?\\b(\\d{1,2})\\b\\s*$",
      jackpot1: "regex:Giáº£i Jackpot 1.*?(\\d[\\d.,]*)",
      jackpot2: "regex:Giáº£i Jackpot 2.*?(\\d[\\d.,]*)",
      rows: ".table tr",
    },
    notes: "Há»— trá»£ sá»‘ Ä‘áº·c biá»‡t vÃ  nhiá»u má»‘c jackpot.",
  },
  power535: {
    type: "power535",
    name: "Power 5/35",
    sourceUrl: "https://www.vietlott.vn/vi/choi/lotto535/gioi-thieu-san-pham-535",
    maxNumber: 35,
    pickCount: 5,
    hasBonus: false,
    drawDays: [1, 2, 3, 4, 5, 6, 7],
    sourceFormat: "manual",
    resultSelectorMap: {
      date: "regex:(\\d{2}/\\d{2}/\\d{4})",
      numbers: "regex:(?:\\b\\d{1,2}\\b(?:\\s*[-,;|]\\s*\\b\\d{1,2}\\b){4,})",
      rows: ".table tr",
    },
    notes: "Lotto 5/35 quay hàng ngày, phù h?p cho ngu?n import GitHub.",
  },
  max3d: {
    type: "max3d",
    name: "Max 3D",
    sourceUrl: "https://www.vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/max-3d",
    maxNumber: 10,
    pickCount: 3,
    hasBonus: false,
    drawDays: [2, 4, 6],
    sourceFormat: "html",
    resultSelectorMap: {
      date: "regex:NgÃ y quay sá»‘.*?(\\d{2}/\\d{2}/\\d{4})",
      numbers: "regex:(?:\\b\\d{1,2}\\b(?:\\s*[-,;|]\\s*\\b\\d{1,2}\\b){2,})",
      rows: ".table tr",
    },
    notes: "Máº«u cáº¥u hÃ¬nh thÃªm cho mÃ n hÃ¬nh Ä‘a giáº£i.",
  },
};

export const LOTTERY_TYPES = Object.keys(LOTTERY_CONFIG) as LotteryType[];


