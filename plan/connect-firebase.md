Tôi đang build một web app Next.js dùng Firebase Firestore cho project phân tích/dự đoán xổ số Vietlott.

Hãy giúp tôi setup Firebase hoàn chỉnh cho Next.js App Router.

Yêu cầu:
- dùng Firebase client SDK cho frontend
- dùng Firebase Admin SDK cho backend/API routes
- dùng TypeScript
- cấu trúc code sạch, production-ready
- giải thích rõ frontend vs backend
- tránh lỗi initialize app nhiều lần
- tránh lỗi private key xuống dòng
- có test connection Firestore

Tech stack:
- Next.js latest App Router
- TypeScript
- Firebase Firestore
- TailwindCSS

Tôi muốn:
1. file .env.local mẫu
2. lib/firebase.ts cho frontend
3. lib/firebase-admin.ts cho backend
4. hướng dẫn lấy Firebase Service Account JSON
5. cách convert JSON thành env
6. ví dụ API route ghi dữ liệu Firestore
7. ví dụ API route đọc dữ liệu Firestore
8. ví dụ React component đọc dữ liệu
9. ví dụ nút “Test Firebase Connection”
10. firestore schema cơ bản cho:
   - lotteries
   - predictions
   - modelPerformance

Yêu cầu code:
- dùng modular Firebase SDK
- dùng singleton pattern
- có error handling
- có loading state
- có console logs dễ debug

Environment variables cần dùng:

Frontend:
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=

Backend:
FIREBASE_SERVICE_ACCOUNT_JSON=

Yêu cầu:
- chỉ dùng FIREBASE_SERVICE_ACCOUNT_JSON cho backend
- không dùng FIREBASE_CLIENT_EMAIL hay FIREBASE_PRIVATE_KEY riêng lẻ
- parse JSON an toàn
- xử lý newline đúng cách

Tạo cho tôi:
- full code
- folder structure
- file names
- import statements đầy đủ
- npm packages cần cài

Packages:
firebase
firebase-admin

Hãy output theo format:
1. install commands
2. folder structure
3. .env.local
4. frontend firebase config
5. backend firebase-admin config
6. API routes
7. React test component
8. Firestore rules cơ bản
9. troubleshooting common errors

Quan trọng:
- tất cả code phải hoạt động ngay
- không pseudo-code
- không bỏ sót imports
- dùng App Router mới của Next.js
- dùng async/await
- giải thích đoạn nào chạy frontend, đoạn nào chạy backend@