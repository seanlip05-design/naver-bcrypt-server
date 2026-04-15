const express = require("express");
const bcrypt = require("bcrypt");

const app = express();
app.use(express.json());

app.post("/naver-token", async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;

    if (!client_id || !client_secret) {
      return res.status(400).json({
        error: "client_id / client_secret 필요"
      });
    }

    const timestamp = Date.now();
    const password = `${client_id}_${timestamp}`;
    const hashed = bcrypt.hashSync(password, client_secret);
    const client_secret_sign = Buffer.from(hashed, "utf-8").toString("base64");

    const body = new URLSearchParams({
      client_id,
      timestamp: String(timestamp),
      client_secret_sign,
      grant_type: "client_credentials",
      type: "SELF"
    });

    const tokenRes = await fetch("https://api.commerce.naver.com/external/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    const text = await tokenRes.text();

    res.status(tokenRes.status).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({
      error: "token 요청 실패",
      detail: String(e)
    });
  }
});

// [수정 완료] 데이일 4대장 데이터 자동 집계 엔진 (날짜 인코딩 + 클레임 검색 수정)
app.post('/naver-daily-summary', async (req, res) => {
  try {
    const { access_token, target_date } = req.body;
    
    // 1단계: 네이버 API가 날짜를 인식할 수 있도록 안전하게 인코딩 (URLSearchParams 사용)
    const fetchIds = async (status) => {
      const params = new URLSearchParams({
        lastChangedFrom: `${target_date}T00:00:00.000+09:00`,
        lastChangedTo: `${target_date}T23:59:59.999+09:00`,
        lastChangedType: status
      });
      const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;
      
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
      const data = await response.json();
      return data.data && data.data.lastChangeStatuses ? data.data.lastChangeStatuses.map(item => item.productOrderId) : [];
    };

    // 2단계: 어제 '결제완료'된 건과 '취소/반품 완료'된 건의 주문번호 싹쓸이
    const payedIds = await fetchIds('PAYED'); 
    const claimIds = await fetchIds('CLAIM_COMPLETED'); // CANCELED 대신 이게 정답입니다.
    
    const allIds = [...new Set([...payedIds, ...claimIds])];

    // 3단계: 긁어온 주문번호로 실제 금액 뜯어보기
    const fetchDetails = async (ids) => {
      if (!ids || ids.length === 0) return { totalPay: 0, totalCancel: 0, totalReturn: 0, totalRefund: 0 };
      
      const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productOrderIds: ids })
      });
      const data = await response.json();
      
      let totalPay = 0, totalCancel = 0, totalReturn = 0, totalRefund = 0;
      
      if (data.data && Array.isArray(data.data)) {
        data.data.forEach(order => {
          const po = order.productOrder || {};
          const id = po.productOrderId;
          const amt = po.totalPaymentAmount || 0;
          
          // M열: 어제 결제된 건이면 매출액에 더하기
          if (payedIds.includes(id)) {
            totalPay += amt;
          }
          
          // N, O, P열: 어제 취소/반품 완료된 건이면 분류해서 더하기
          if (claimIds.includes(id)) {
            if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') {
              totalCancel += amt; // N열 (스토어취소)
            } else if (po.claimType === 'RETURN') {
              totalReturn += amt; // O열 (스토어반품)
            }
            
            // P열 (찐 환불금액 찾기)
            let exactRefund = 0;
            if (order.completedClaims && order.completedClaims.length > 0) {
               order.completedClaims.forEach(c => {
                   exactRefund += (c.refundAmount || c.totalRefundAmount || 0);
               });
            }
            // 환불내역을 못 찾았다면 취소된 원래 상품금액으로 대체
            totalRefund += (exactRefund > 0 ? exactRefund : amt);
          }
        });
      }
      return { totalPay, totalCancel, totalReturn, totalRefund };
    };

    const results = await fetchDetails(allIds);

    res.json({
      date: target_date,
      pay: results.totalPay,       
      cancel: results.totalCancel, 
      return: results.totalReturn, 
      refund: results.totalRefund  
    });

  } catch (error) {
    console.error('집계 에러:', error);
    res.status(500).json({ error: '데이터 집계 실패', detail: String(error) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// 서버의 진짜 IP를 확인하기 위한 비밀 통로
app.get("/myip", async (req, res) => {
  const ipRes = await fetch("https://api.ipify.org");
  const ip = await ipRes.text();
  res.send("현재 Render 서버의 출입증(IP) 번호: " + ip);
});
