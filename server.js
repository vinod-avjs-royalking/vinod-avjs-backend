const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
let users = [];
let tasks = [];
let withdrawals = [];
app.get('/', (req,res)=>{
  res.json({message:"VINOD AVJS ROYAL APPS Backend Running", status:"OK"});
});
app.post('/api/register', (req,res)=>{
  const {name, phone} = req.body;
  const user = {id:"RK-"+Date.now(), name, phone, balance:0};
  users.push(user);
  res.json({success:true, user});
});
app.post('/api/task-complete', (req,res)=>{
  const {userId, task, amount} = req.body;
  tasks.push({userId, task, amount, time:new Date()});
  const u = users.find(x=>x.id===userId);
  if(u) u.balance += amount;
  res.json({success:true, message:"Rs "+amount+" added"});
});
app.post('/api/withdraw', (req,res)=>{
  const {userId, upi, amount} = req.body;
  if(amount < 100) return res.json({success:false, message:"Minimum Rs 100 hai"});
  withdrawals.push({userId, upi, amount, status:"Pending"});
  res.json({success:true, message:"Withdrawal Pending"});
});
app.get('/api/admin/stats', (req,res)=>{
  const totalRevenue = tasks.reduce((s,t)=>s + t.amount*2, 0);
  const userPayout = tasks.reduce((s,t)=>s + t.amount, 0);
  res.json({totalUsers: users.length, totalRevenue, userPayout, profit: totalRevenue-userPayout});
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Running on "+PORT));
