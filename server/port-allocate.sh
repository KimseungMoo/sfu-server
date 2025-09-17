# 4개의 스트림 할당
curl -X POST http://localhost:8080/api/port/allocate \
  -H "Content-Type: application/json" \
  -d '{"trainingId":"T001","sessionId":"S001","studentId":"ST001"}'

  curl -X POST http://localhost:8080/api/port/allocate \
  -H "Content-Type: application/json" \
  -d '{"trainingId":"T001","sessionId":"S001","studentId":"ST002"}'

  curl -X POST http://localhost:8080/api/port/allocate \
  -H "Content-Type: application/json" \
  -d '{"trainingId":"T001","sessionId":"S001","studentId":"ST003"}'

  curl -X POST http://localhost:8080/api/port/allocate \
  -H "Content-Type: application/json" \
  -d '{"trainingId":"T001","sessionId":"S001","studentId":"ST004"}'