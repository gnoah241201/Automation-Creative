# ResizeVideo - Deploy Ubuntu Bang Docker

Tai lieu nay huong dan trien khai nhanh len 1 server Ubuntu theo huong Docker de de van hanh truoc production.

## 1. Cai dat Docker tren Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo systemctl enable docker
sudo systemctl start docker
```

## 2. Dua toan bo project len VM Ubuntu

### Cach A: Dung script PowerShell (khuyen nghi tren Windows)

Chay tu may Windows (thu muc project):

```powershell
.\upload-to-ubuntu-vm.ps1 -VmHost <VM_IP> -VmUser <VM_USER> -RunRemoteExtract
```

Neu SSH cua ban dung port khac:

```powershell
.\upload-to-ubuntu-vm.ps1 -VmHost <VM_IP> -VmUser <VM_USER> -VmPort 2222 -RunRemoteExtract
```

Script se:

- Nen toan bo project (bo qua .git, node_modules, dist)
- Upload len VM qua SCP
- Tu dong giai nen vao /home/<VM_USER>/resize-video

Neu ban muon dung duong dan khac:

```powershell
.\upload-to-ubuntu-vm.ps1 -VmHost <VM_IP> -VmUser <VM_USER> -RemoteDir /opt/resize-video -RunRemoteExtract
```

### Cach B: Clone tren VM

Neu VM co internet va truy cap GitHub:

```bash
git clone https://github.com/gnoah241201/ResizeVideo.git
cd ResizeVideo
```

## 3. Trien khai ung dung bang Docker

Tao file bien moi truong cho docker compose:

```bash
cat > .env <<EOF
APP_PORT=8080
MAX_CONCURRENT_JOBS=5
FFMPEG_ENCODER=libx264
GOOGLE_OAUTH_CLIENT_ID=YOUR_GOOGLE_OAUTH_CLIENT_ID
GOOGLE_WORKSPACE_DOMAIN=bravestars.com
APP_AUTH_SECRET=change-this-secret-before-public-use
APP_AUTH_COOKIE_SECURE=false
VITE_GOOGLE_OAUTH_CLIENT_ID=YOUR_GOOGLE_OAUTH_CLIENT_ID
VITE_GOOGLE_WORKSPACE_DOMAIN=bravestars.com
EOF
```

Khoi dong stack:

```bash
cd /home/<VM_USER>/resize-video   # Neu clone truc tiep thi cd ResizeVideo
sudo docker compose up --build -d
```

## 4. Kiem tra sau deploy

```bash
sudo docker compose ps
curl -sS http://localhost:8080/api/health
```

Neu ban mo firewall cloud theo IP cong khai, truy cap:

http://SERVER_IP:8080

## 5. Van hanh hang ngay

Xem log:

```bash
sudo docker compose logs -f backend
sudo docker compose logs -f frontend
```

Restart stack:

```bash
sudo docker compose restart
```

Update phien ban moi:

```bash
git pull origin main
sudo docker compose down
sudo docker compose up --build -d
```

## 6. Du lieu render

Volume du lieu ten la render_data, duoc giu lai khi down stack thong thuong:

```bash
sudo docker volume ls | grep render_data
```

Xoa ca du lieu render (chi dung khi can reset hoan toan):

```bash
sudo docker compose down -v
```

## 7. Checklist truoc production

- Dat reverse proxy HTTPS (Nginx host hoac load balancer)
- Gioi han port public chi de 80/443
- Cau hinh monitoring va alert cho container restart, CPU, RAM, disk
- Co chinh sach backup volume render_data
- Test tai cao diem voi MAX_CONCURRENT_JOBS phu hop

## 8. Gan domain bang Nginx tren host VM

Domain dang dung: `resize.bravestars.com`

Repo da co 2 file mau:

- `nginx-resize.bravestars.com.http.conf` cho buoc HTTP-first
- `nginx-resize.bravestars.com.https.conf` cho buoc sau khi co SSL

### Buoc 8.1: Copy va chay HTTP truoc

```bash
sudo cp /home/<VM_USER>/resize-video/nginx-resize.bravestars.com.http.conf /etc/nginx/sites-available/resize-bravestars-com
sudo ln -sf /etc/nginx/sites-available/resize-bravestars-com /etc/nginx/sites-enabled/resize-bravestars-com
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Kiem tra:

```bash
curl -I http://resize.bravestars.com
```

### Buoc 8.2: Cap SSL bang certbot standalone

Neu `certbot --nginx` bi loi vi cert chua ton tai, dung standalone de cap cert lan dau:

```bash
sudo apt-get update
sudo apt-get install -y certbot
sudo systemctl stop nginx
sudo certbot certonly --standalone -d resize.bravestars.com
sudo systemctl start nginx
```

### Buoc 8.3: Chuyen sang HTTPS

Sau khi co cert, thay file dang chay bang ban HTTPS template:

```bash
sudo cp /home/<VM_USER>/resize-video/nginx-resize.bravestars.com.https.conf /etc/nginx/sites-available/resize-bravestars-com
sudo nginx -t
sudo systemctl reload nginx
```

Ban co the thu ban nay truoc de giam nguy co upload cham qua domain: no da tat `http2` va them tuy chinh buffering toi uu cho file lon.

Sau do kiem tra lai block cert da dung 2 duong dan sau:

```nginx
ssl_certificate /etc/letsencrypt/live/resize.bravestars.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/resize.bravestars.com/privkey.pem;
```

Cuoi cung:

```bash
curl -I https://resize.bravestars.com
```

### Cach test tung phuong an

1. Upload cung 1 file qua `http://SERVER_IP:8080` va qua `https://resize.bravestars.com`.
2. Neu IP nhanh nhung domain cham, reload Nginx voi ban HTTPS da tat `http2`.
3. Neu van cham, kiem tra DNS/IPv6 hoac middlebox tren duong di.
4. Neu muon, tam thoi test qua HTTP tren domain neu moi truong cho phep.

### Neu muon canh nhanh

Ban co the de HTTP truoc, sau do cap SSL vao luc khac. Muc tieu la domain phai truy cap duoc qua HTTP truoc khi chen cert HTTPS.

## 10. Dang nhap va DNS noi bo tren Mikrotik

### 10.0 Tao Google OAuth Client cho Workspace

Truoc khi bat app, can tao OAuth client tren Google Cloud Console:

1. Vao Google Cloud Console -> **APIs & Services** -> **OAuth consent screen**.
2. Chon **Internal** neu chi dung trong cong ty Google Workspace.
3. Tao **OAuth Client ID** loai **Web application**.
4. Them **Authorized JavaScript origins**:
  - `http://resize.bravestars.com`
  - `https://resize.bravestars.com`
  - `http://localhost:8080` (neu test local)
5. Copy **Client ID** vao bien moi truong:
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `VITE_GOOGLE_OAUTH_CLIENT_ID`
6. Dat `GOOGLE_WORKSPACE_DOMAIN=bravestars.com`.

### 10.1 Bat login Google Workspace trong Docker

Backend da co login cookie-based qua Google OIDC. Chi can de bien moi truong trong `.env` va restart stack:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_WORKSPACE_DOMAIN`
- `APP_AUTH_SECRET`
- `APP_AUTH_COOKIE_SECURE`
- `VITE_GOOGLE_OAUTH_CLIENT_ID`
- `VITE_GOOGLE_WORKSPACE_DOMAIN`

Neu chi dung LAN va chua co HTTPS, de:

```bash
APP_AUTH_COOKIE_SECURE=false
```

Neu da co HTTPS, doi sang:

```bash
APP_AUTH_COOKIE_SECURE=true
```

### 10.2 Gan domain `resize.bravestars.com` ve `10.1.1.50` tren Mikrotik

Muc tieu la moi may trong LAN go `resize.bravestars.com` se tro ve server Ubuntu `10.1.1.50`.

#### Cach lam bang GUI

1. Dang nhap Mikrotik bang Winbox hoac WebFig.
2. Vao **IP** -> **DNS**.
3. Bat **Allow Remote Requests**.
4. Vao tab **Static** -> bam **+**.
5. Dien:
  - Name: `resize.bravestars.com`
  - Address: `10.1.1.50`
6. Save.

#### Cach lam bang command line

```bash
/ip dns set allow-remote-requests=yes
/ip dns static add name=resize.bravestars.com address=10.1.1.50
```

### 10.3 De client trong LAN tu dong dung DNS cua router

Neu DHCP dang cap cho client tu Mikrotik, gan DNS server cua router trong DHCP network:

#### GUI

1. Vao **IP** -> **DHCP Server** -> **Networks**.
2. Mo network dang dung.
3. Dien **DNS Servers** la IP router Mikrotik hoac DNS noi bo cua ban.
4. Save.

#### Command line

```bash
/ip dhcp-server network set [find] dns-server=192.168.200.1
```

Thay `192.168.200.1` bang IP router Mikrotik cua ban neu router cua ban dung IP khac.

### 10.4 Truy cap bang domain

Sau khi xong:

```text
http://resize.bravestars.com
```

Khi vao app, ban se thay nut dang nhap Google Workspace. Chi cac tai khoan thuoc domain `bravestars.com` moi dang nhap duoc.

Neu ban muon dung HTTPS noi bo, co 2 cach:

1. Dung cert hop le cho domain nay, con DNS noi bo chi tro ve `10.1.1.50`.
2. Dung self-signed/internal CA va import cert vao may client.

Neu ban chi can LAN va chua lam SSL, co the chay HTTP + login truoc, sau do bat HTTPS sau.

## 9. Gioi han chi nguoi trong cong ty duoc truy cap

### Cach khuyen nghi: khoa theo IP cong ty/VPN tai Nginx

Hai file Nginx da co san block allow/deny mau:

- `nginx-resize.bravestars.com.http.conf`
- `nginx-resize.bravestars.com.https.conf`

Ban can thay cac CIDR mau bang IP egress that cua cong ty:

```nginx
allow 203.0.113.0/24;
allow 198.51.100.10/32;
deny all;
```

Sau khi sua file:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Tranh bi khoa nham chinh minh

- Luon them IP hien tai cua ban (hoac VPN) vao allow list truoc khi reload.
- Mo 1 SSH session du phong truoc khi apply config moi.
- Neu bi khoa web, ban van co the SSH vao server de sua lai allow list.

### Lop bao ve them o DigitalOcean Firewall

Ngoai Nginx, nen dat Cloud Firewall:

- Chi mo TCP 22 cho IP quan tri
- Chi mo TCP 80/443 cho CIDR cong ty (neu muon khoa chat hon nua)

Khi doi IP cong ty/VPN, can cap nhat ca Nginx allow list va DigitalOcean Firewall.
