// Synthetic moving pixels; uses the production recorder/IPC/encoder after this seam.
const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
const ctx = canvas.getContext('2d'); let frame = 0;
setInterval(() => { ctx.fillStyle = `hsl(${frame++ % 360} 80% 50%)`; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = 'white'; ctx.fillRect(frame % 280, 40, 40, 40); }, 33);
navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
