Bổ sung thêm các module nâng cao để app dự đoán/phân tích tốt hơn và tránh overfitting:

1. Backtesting nghiêm túc
- Tạo rolling backtest:
  - dùng N kỳ trước để train
  - dự đoán kỳ tiếp theo
  - so với kết quả thật
  - lặp lại qua toàn bộ lịch sử
- Không được dùng dữ liệu tương lai để train cho kỳ quá khứ.
- Lưu kết quả backtest vào Firestore.

2. Random baseline comparator
- Mỗi lần backtest, tạo thêm bộ số random cùng số lượng với model.
- So sánh:
  - model average match
  - random average match
  - model edge = modelAvg - randomAvg
- Nếu model không tốt hơn random thì cảnh báo.

3. Coverage optimizer
- Khi generate nhiều bộ số, không để các bộ quá giống nhau.
- Giới hạn overlap giữa 2 bộ, ví dụ tối đa trùng 2–3 số.
- Đảm bảo các bộ phủ đa dạng:
  - vùng thấp / trung / cao
  - odd/even
  - tổng điểm
  - hot/cold mix
- Thêm coverageScore vào mỗi generated set.

4. Prize rules evaluator
Thêm config luật trúng thưởng cho từng giải:

prizeRules: [
  { match: 6, bonusMatch: 0, tier: "Jackpot" },
  { match: 5, bonusMatch: 0, tier: "Giải nhất" },
  { match: 4, bonusMatch: 0, tier: "Giải nhì" },
  { match: 3, bonusMatch: 0, tier: "Giải ba" }
]

Với Power 6/55, hỗ trợ số đặc biệt/bonus number.

5. Data quality checker
Sau khi crawl data, kiểm tra:
- thiếu kỳ quay
- trùng kỳ quay
- sai số lượng số
- số ngoài range
- ngày sai format
- kết quả thiếu bonus number nếu giải cần bonus
- format website thay đổi

Nếu lỗi thì lưu vào collection crawlLogs và không cho model học từ data lỗi.

6. Model versioning
Mỗi prediction phải lưu:
- modelVersion
- algorithmVersion
- weightsSnapshot
- configSnapshot
- generatedAt

Mỗi lần đổi thuật toán hoặc đổi weights lớn, tăng version.

7. Pattern quality score
Không chỉ tính số trùng, mà phải đánh giá pattern nào đóng góp tốt.

Lưu thống kê:

patternPerformance: {
  frequency: {
    usedCount,
    avgMatch,
    randomBaseline,
    edge,
    lastUpdated
  },
  coldNumber: {
    usedCount,
    avgMatch,
    randomBaseline,
    edge,
    lastUpdated
  }
}

Nếu pattern có edge âm nhiều kỳ liên tiếp thì tự giảm weight.

8. Anti-overfitting rules
- Không tăng weight mạnh chỉ vì 1 kỳ trúng tốt.
- Dùng learningRate mặc định 0.03–0.05.
- Có minWeight và maxWeight.
- Có maxWeightChangePerUpdate.
- Dùng rolling average ít nhất 20–50 kỳ.
- Pattern chỉ được tăng weight nếu tốt hơn random baseline trong nhiều kỳ.

9. Budget management
Thêm module quản lý tiền mua vé:
- ngân sách mỗi kỳ
- giá mỗi vé
- số bộ tối đa được mua
- tổng tiền đã mua
- tổng tiền trúng
- lời/lỗ
- ROI
- cảnh báo nếu vượt ngân sách

10. Manual feedback
Khi user chọn bộ số để mua, cho phép lưu lý do:
- chọn vì score cao
- chọn vì coverage tốt
- chọn thủ công
- chọn vì cảm giác
- chọn vì theo pattern riêng

Dùng dữ liệu này để tách hiệu quả model và hiệu quả lựa chọn cá nhân.

11. Dashboard bổ sung
Tạo thêm các trang:
- Backtesting Dashboard
- Random Baseline Comparison
- Coverage Analysis
- Pattern Performance
- Data Quality Logs
- Budget / ROI Tracker
- Model Versions

12. Disclaimer bắt buộc
Hiển thị rõ trong UI:

“Đây là công cụ phân tích thống kê và mô phỏng. Xổ số là ngẫu nhiên, không có thuật toán nào đảm bảo dự đoán chính xác kết quả.”