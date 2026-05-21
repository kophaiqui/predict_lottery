Hãy sửa app Next.js của tôi để không crawl trực tiếp vietlott.vn nữa.

Thay vào đó dùng data source từ:
https://github.com/vietvudanh/vietlott-data

Yêu cầu:
1. Tạo API route:
POST /api/import-vietlott-data?lotteryType=mega645

2. API này sẽ:
- đọc data raw từ GitHub repo vietvudanh/vietlott-data
- map lotteryType sang file data tương ứng
- parse JSONL/JSON/CSV nếu có
- normalize về schema actualDraws
- lưu vào MongoDB
- tránh duplicate bằng lotteryType + drawId
- trả về inserted, updated, skipped

3. Không dùng crawler cũ từ vietlott.vn nữa cho phase này.

4. Tạo config:

const VIETLOTT_DATA_SOURCES = {
  power655: {
    productName: "Power 6/55",
    pickCount: 6,
    maxNumber: 55,
    rawUrl: "RAW_GITHUB_URL_HERE"
  },
  mega645: {
    productName: "Mega 6/45",
    pickCount: 6,
    maxNumber: 45,
    rawUrl: "RAW_GITHUB_URL_HERE"
  },
  power535: {
    productName: "Power 5/35",
    pickCount: 5,
    maxNumber: 35,
    rawUrl: "RAW_GITHUB_URL_HERE"
  }
};

5. Tạo function:
importVietlottData(lotteryType)

Nó phải:
- fetch rawUrl
- parse từng dòng JSONL nếu là JSONL
- normalize field:
  - lotteryType
  - drawId
  - drawDate
  - numbers
  - bonusNumbers
  - source: "vietvudanh/vietlott-data"
  - importedAt
- validate:
  - numbers đúng số lượng
  - numbers nằm trong range
  - drawDate hợp lệ
  - drawId không rỗng

6. Nếu field trong repo là:
{
  date,
  id,
  result,
  process_time
}

Thì map thành:
{
  lotteryType,
  drawId: id,
  drawDate: date,
  numbers: result.slice(0, pickCount),
  bonusNumbers: result.slice(pickCount),
  source: "github:vietvudanh/vietlott-data",
  crawledAt: process_time
}

7. Sau khi import xong, Prediction Screen phải dùng actualDraws trong MongoDB để dự đoán.

8. Tạo nút trên UI:
"Update Data From GitHub"

Khi bấm:
- gọi /api/import-vietlott-data cho từng giải
- hiển thị số record inserted/updated
- hiển thị latest draw date