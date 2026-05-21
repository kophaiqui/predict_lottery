Hãy xây dựng một web app dự đoán/xếp hạng bộ số Vietlott bằng phân tích thống kê, pattern và machine learning nhẹ. Lưu ý: app không được claim “dự đoán chắc chắn”, mà hiển thị như công cụ phân tích xác suất/tham khảo.

Mục tiêu:
Tạo web app có khả năng crawl dữ liệu kết quả từ https://www.vietlott.vn/, lưu vào Firebase, phân tích nhiều loại giải Vietlott khác nhau, sinh dự đoán cho kỳ tiếp theo, so sánh dự đoán với kết quả thật sau khi có kết quả, rồi dùng sai số/lịch sử performance để điều chỉnh trọng số cho các lần dự đoán sau.

Tech stack đề xuất:
- Frontend: Next.js hoặc React + TailwindCSS
- Backend/API: Next.js API routes hoặc Firebase Functions
- Database: Firebase Firestore
- Auth: Firebase Auth optional
- Hosting: Firebase Hosting hoặc Vercel
- Scheduler optional: Firebase Scheduled Functions

Yêu cầu chính:

1. Cấu hình biến map linh hoạt
Tạo file config để tôi tự map các loại giải Vietlott, ví dụ:

const LOTTERY_CONFIG = {
  mega645: {
    name: "Mega 6/45",
    sourceUrl: "",
    maxNumber: 45,
    pickCount: 6,
    hasBonus: false,
    drawDays: [],
    resultSelectorMap: {
      date: "",
      numbers: "",
      jackpot: ""
    }
  },
  power655: {
    name: "Power 6/55",
    sourceUrl: "",
    maxNumber: 55,
    pickCount: 6,
    hasBonus: true,
    bonusName: "specialNumber",
    resultSelectorMap: {
      date: "",
      numbers: "",
      specialNumber: "",
      jackpot1: "",
      jackpot2: ""
    }
  }
};

Không hard-code selector Vietlott. Tạo biến để tôi tự map URL, CSS selector, regex parser hoặc API endpoint nếu tìm được.

2. Crawl data
Tạo nút “Crawl / Update Data” trên dashboard.
Khi bấm:
- crawl dữ liệu từ Vietlott theo từng loại giải
- parse ngày quay, bộ số, số đặc biệt nếu có, jackpot nếu có
- normalize dữ liệu về cùng format
- lưu vào Firestore
- tránh duplicate bằng drawId hoặc lotteryType + drawDate
- hiển thị trạng thái: đang crawl, thành công, lỗi, số bản ghi mới

Firestore structure đề xuất:

lotteries/{lotteryType}/draws/{drawId}
{
  lotteryType,
  drawDate,
  drawId,
  numbers: [1, 5, 12, 24, 33, 40],
  bonusNumbers: [],
  jackpotData: {},
  sourceUrl,
  createdAt,
  updatedAt
}

predictions/{predictionId}
{
  lotteryType,
  targetDrawDate,
  generatedAt,
  predictedSets: [
    {
      numbers: [],
      score: 0.82,
      patternBreakdown: {},
      modelWeights: {}
    }
  ],
  status: "pending" | "checked",
  actualResult: null,
  accuracy: null
}

modelPerformance/{lotteryType}
{
  weights: {},
  patternStats: {},
  lastUpdated
}

3. Mỗi giải tính như nhau
Thiết kế engine phân tích chung cho mọi loại giải.
Mỗi giải chỉ khác config:
- maxNumber
- pickCount
- có số đặc biệt hay không
- format kết quả
- lịch quay
Không viết logic riêng lẻ cho từng giải nếu không cần.

4. Prediction engine
Tạo nhiều pattern và mỗi pattern có trọng số riêng:

Pattern gợi ý:
- Frequency pattern: số xuất hiện nhiều
- Cold number pattern: số lâu chưa xuất hiện
- Recent trend pattern: số xuất hiện trong N kỳ gần nhất
- Gap pattern: khoảng cách giữa các số
- Odd/even ratio
- Low/high ratio
- Sum range pattern
- Consecutive number pattern
- Ending digit pattern
- Number pair/co-occurrence pattern
- Repeat from previous draw pattern
- Moving average frequency
- Draw cycle pattern
- Entropy/randomness balance
- Monte Carlo simulation

Mỗi pattern trả về điểm cho từng số hoặc từng bộ số.
Sau đó combine bằng weighted scoring:

finalScore = Σ(patternScore * patternWeight)

Tạo UI cho phép chỉnh trọng số từng pattern:
- slider 0–100
- bật/tắt pattern
- lưu weight vào Firebase

5. Sinh dự đoán
Cho mỗi loại giải:
- chọn lotteryType
- chọn số lượng bộ số muốn sinh, ví dụ 10/20/50
- chạy prediction engine
- sinh nhiều bộ số khác nhau
- rank theo finalScore
- hiển thị:
  - bộ số
  - điểm tổng
  - breakdown theo pattern
  - lý do gợi ý
  - confidence label: Low / Medium / High, nhưng không claim chắc thắng

6. Learning từ kết quả thật
Sau khi có kết quả thật:
- lấy prediction pending gần nhất
- so sánh predictedSets với actual numbers
- tính accuracy:
  - số trùng
  - match rate
  - hit distribution
  - pattern nào đóng góp tốt
- cập nhật modelPerformance
- tăng nhẹ weight cho pattern có đóng góp tốt
- giảm nhẹ weight cho pattern sai nhiều
- dùng learning rate để tránh thay đổi quá mạnh

Ví dụ:
newWeight = oldWeight + learningRate * performanceDelta

Có giới hạn:
- minWeight = 0
- maxWeight = 100
- learningRate configurable

7. Dashboard
Tạo các màn hình:
- Tổng quan dữ liệu
- Crawl/update data
- Danh sách kết quả đã lưu
- Prediction generator
- Pattern weight settings
- Backtesting
- Prediction history
- Model performance

8. Backtesting
Cho phép chọn:
- lotteryType
- khoảng thời gian
- số kỳ dùng để train
- số kỳ dùng để test

App sẽ giả lập:
- dùng dữ liệu trước kỳ X để dự đoán kỳ X
- so với kết quả thật
- thống kê hiệu quả từng pattern
- hiển thị chart/table

9. UI/UX
Giao diện tiếng Việt.
Thiết kế sạch, hiện đại.
Có cảnh báo rõ:
“Đây là công cụ phân tích thống kê và tham khảo. Xổ số là ngẫu nhiên, không có thuật toán nào đảm bảo dự đoán chính xác kết quả.”

10. Code quality
- Tách module rõ:
  - crawler
  - parser
  - firebase service
  - prediction engine
  - pattern modules
  - backtesting engine
  - UI components
- Có TypeScript types
- Có error handling
- Có loading state
- Có logging
- Có comments cho phần prediction logic

11. Output mong muốn
Hãy tạo:
- cấu trúc thư mục project
- schema Firestore
- code mẫu các module chính
- UI dashboard cơ bản
- prediction engine có thể mở rộng
- config mapper cho Vietlott
- nút crawl data
- backtesting cơ bản
- weight learning mechanism