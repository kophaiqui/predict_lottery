export const VIETLOTT_DATA_SOURCES = {
  mega645: {
    productName: "Mega 6/45",
    pickCount: 6,
    maxNumber: 45,
    rawUrl: "https://raw.githubusercontent.com/vietvudanh/vietlott-data/main/data/power645.jsonl",
  },
  power655: {
    productName: "Power 6/55",
    pickCount: 6,
    maxNumber: 55,
    rawUrl: "https://raw.githubusercontent.com/vietvudanh/vietlott-data/main/data/power655.jsonl",
  },
  power535: {
    productName: "Power 5/35",
    pickCount: 5,
    maxNumber: 35,
    rawUrl: "https://raw.githubusercontent.com/vietvudanh/vietlott-data/main/data/power535.jsonl",
  },
} as const;

export type VietlottDataLotteryType = keyof typeof VIETLOTT_DATA_SOURCES;
