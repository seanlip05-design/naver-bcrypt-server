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

// [신규 추가] 데이일 4대장(M, N, O, P) 데이터 자동 집계 엔진 (환불액 독립 추출)
app.post('/naver-daily-summary', async (req, res) => {
  try {
    const { access_token, target_date } = req.body;
    const start = `${target_date}T00:00:00.000+09:00`;
    const end = `${target_date}T23:59:59.999+09:00`;

    const fetchIds = async (status) => {
      const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?lastChangedFrom=${start}&lastChangedTo=${end}&lastChangedType=${status}`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
      const data = await response.json();
      return data.data && data.data.lastChangeStatuses ? data.data.lastChangeStatuses.map(item => item.productOrderId) : [];
    };

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
          const claim = order.claim || {};
          
          totalPay += (po.totalPaymentAmount || 0); // M열: 결제금액
          if (po.productOrderStatus === 'CANCELED') totalCancel += (po.totalPaymentAmount || 0); // N열: 스토어취소
          if (po.productOrderStatus === 'RETURNED') totalReturn += (po.totalPaymentAmount || 0); // O열: 스토어반품
          
          // P열: 클레임 정보에서 찐 환불금액만 독립적으로 추출
          if (claim.refundInfo && claim.refundInfo.refundAmount) {
             totalRefund += claim.refundInfo.refundAmount; 
          }
        });
      }
      return { totalPay, totalCancel, totalReturn, totalRefund };
    };

    const payedIds = await fetchIds('PAYED');
    const canceledIds = await fetchIds('CANCELED');
    const returnedIds = await fetchIds('RETURNED');
    
    const allIds = [...new Set([...payedIds, ...canceledIds, ...returnedIds])];
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
