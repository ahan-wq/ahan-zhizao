阿憨植造 · Render 临时部署包
============================
1. 本包已含 JS 混淆（index.html / admin.html）与精简素材（每父类精选，测试用）。
2. 部署步骤：
   a) 打开 https://github.com 注册/登录账号
   b) 右上角 New → Create a new repository → 仓库名写 ahan-zhizao → 选 Public → Create
   c) 本目录已在 git 仓库内可直接推送（或按本目录 README 推送命令）
   d) 打开 https://render.com → New + → Web Service → 连接 GitHub 选 ahan-zhizao 仓库
   e) Name: ahan-zhizao；Region: Singapore（选离国内近的）；
      Runtime: Node；Build Command: 留空；Start Command: node server.js；
      Instance Type: Free
   f) 点 Create Web Service，等 2-5 分钟构建
   g) 完成后打开 https://ahan-zhizao.onrender.com 即可测试
3. 注意：
   - 免费层 15 分钟无访问会休眠，再次访问等 10-30 秒唤醒属正常
   - 免费层磁盘不持久，上传的新素材重启后会丢失（仅测试用）
   - 登录账号: admin / 123456
4. 正式上线请用国内服务器 + 域名备案，见部署说明.txt 思路。
