Hãy chuyển toàn bộ database layer của project Next.js Vietlott prediction từ Firebase sang MongoDB Atlas.

Yêu cầu:
- Dùng Next.js App Router
- TypeScript
- MongoDB Atlas
- Mongoose hoặc MongoDB native driver
- Chỉ dùng 1 biến môi trường:
  MONGODB_URI=
- Không dùng Firebase nữa
- Tạo connection singleton để tránh reconnect nhiều lần

Tạo các collections:
1. actualDraws
2. generatedPredictions
3. purchasedSets
4. evaluations
5. modelPerformance
6. crawlLogs
7. modelVersions
8. backtestResults

Tạo schema/model cho:
- ActualDraw
- GeneratedPrediction
- PurchasedSet
- Evaluation
- ModelPerformance
- CrawlLog
- BacktestResult

Tạo API routes:
- POST /api/crawl
- POST /api/predict
- POST /api/purchase
- POST /api/evaluate
- GET /api/test-db

Yêu cầu /api/test-db:
- connect MongoDB
- insert 1 document test
- đọc lại document đó
- trả về success true nếu hoạt động

Cấu trúc thư mục:
lib/mongodb.ts
models/ActualDraw.ts
models/GeneratedPrediction.ts
models/PurchasedSet.ts
models/Evaluation.ts
models/ModelPerformance.ts
models/CrawlLog.ts
models/BacktestResult.ts
app/api/test-db/route.ts
app/api/crawl/route.ts
app/api/predict/route.ts
app/api/purchase/route.ts
app/api/evaluate/route.ts

Yêu cầu code:
- code chạy được ngay
- không pseudo-code
- có error handling
- có console logs
- dùng async/await
- không hard-code connection string
- dùng process.env.MONGODB_URI
- tạo index chống duplicate:
  actualDraws: lotteryType + drawId unique
  generatedPredictions: lotteryType + targetDrawDate
  purchasedSets: lotteryType + targetDrawDate
  evaluations: lotteryType + drawId unique

Luồng dữ liệu:
1. Crawl Vietlott -> lưu actualDraws
2. Generate prediction -> lưu generatedPredictions
3. User chọn mua -> lưu purchasedSets
4. Crawl kết quả mới -> so sánh actualDraws với generatedPredictions và purchasedSets
5. Lưu evaluations
6. Update modelPerformance để cải thiện lần dự đoán sau

Quan trọng:
- không claim dự đoán chắc chắn trúng xổ số
- thêm disclaimer trong UI
- ưu tiên database flow chạy được trước, UI làm sau