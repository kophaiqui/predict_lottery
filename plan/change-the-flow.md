Hãy simplify toàn bộ UI và product flow.

Mục tiêu:
Đây là một “Lottery Recommendation Engine”, không phải dashboard kỹ thuật.

User chỉ quan tâm:
1. Giải hiện tại
2. Jackpot hiện tại
3. Bộ số đề xuất tiếp theo
4. Số đã mua
5. Kết quả trúng/thua
6. Một màn hình analytics đơn giản

Ưu tiên UX đơn giản, mobile-first, prediction-centric.

Ẩn toàn bộ technical details khỏi main screen:
- pattern weights
- ML internals
- learning rate
- model configs
- debug metrics

Chỉ để các phần đó trong tab Analytics.

App structure mới:

1. Prediction Screen (main screen)
- list tất cả giải
- jackpot hiện tại
- draw date tiếp theo
- predicted numbers
- confidence
- coverage
- generate again
- save purchased numbers

2. Purchased Numbers
- nhập số user đã mua
- lưu theo draw date
- compare với kết quả thật sau khi crawl

3. Analytics
- hot numbers
- cold numbers
- odd/even trends
- sum range trends
- most effective patterns
- algorithm performance
- historical comparison

4. System
- DB status
- last crawl
- sync logs

Database collections:
- actualDraws
- generatedPredictions
- purchasedNumbers
- evaluationResults
- systemLogs

Tự động:
- crawl kết quả mới
- evaluate purchased numbers
- evaluate generated predictions
- update scoring weights

Quan trọng:
Prediction screen phải là trung tâm của toàn bộ sản phẩm.