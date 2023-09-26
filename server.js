const express = require('express');
const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs');
const wf = require('fs/promises');
const path = require('path');
require('dotenv').config({
 path: path.resolve('.', './.env')
});
registerFont('DejaVuSerif.ttf', { family: 'DejaVu Serif' });
registerFont('NotoSerif-Light.ttf', { family: 'Noto Serif Light' });

const app = express();
const port = 50000;

app.use(express.json());

app.post('/quotable', async (req, res) => {
 try {
  const quoteText = req.body.quote;
  const authorText = req.body.author;
  
  // Font and text options
  const quoteFont = '64px DejaVu Serif';
  const authorFont = '30px Noto Serif Light';
  const backgroundColor = '#000000'; // Black background
  const textColor = '#FFFFFF';
  const outputDir = process.env.MNAPI_OUTDIR;
  
  // Create the output directory if it doesn't exist
  console.log(outputDir);
  if (!fs.existsSync(outputDir)) {
   fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const width = 1920;
  const height = 1080;
  
  const quoteLines = quoteText.split('\n');
  const qlincnt = quoteLines.length;

  const authorLines = authorText.split('\n');
  const alincnt = authorLines.length;
  authorLines[0] = `~ ${authorLines[0]}`;
  
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  ctx.antialias = 'default';

  ctx.font = quoteFont;
  ctx.textAlign = 'left';
  ctx.fillStyle = textColor;

  var quotationSize = ctx.measureText('“');

  let qrects = [];
  let arects = [];
  let twidth = 0;
  let theight = 0;

  const qrecth = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890');
  const qheight = qrecth.actualBoundingBoxAscent + qrecth.actualBoundingBoxDescent;

  quoteLines.forEach(qline => {
   const rect = ctx.measureText(qline);
   twidth = Math.max(twidth, rect.width);
   theight += qheight + 4;
   qrects.push(rect);
  });
  theight += 10;
  ctx.font = authorFont;
  const arecth = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890');
  const aheight = arecth.actualBoundingBoxAscent + arecth.actualBoundingBoxDescent;
  authorLines.forEach(aline => {
   const rect = ctx.measureText(aline);
   twidth = Math.max(twidth, rect.width);
   theight += aheight + 3;
   arects.push(rect);
  });

  let cvert = 0;
  let qind = 0;

  ctx.font = quoteFont;

  quoteLines.forEach(qline => {
   let move = 0;
   if (qind == 0) move = -quotationSize.width;
   const text = (qind == 0 ? '“' : '') + qline + (qind == qlincnt - 1 ? '”' : '');
   ctx.fillText(text, width / 2 - qrects[qind++].width / 2 + move, height / 2 - theight / 2 + cvert);
   cvert += qheight + 4;
  });

  let aind = 0;
  cvert += 10;

  ctx.font = authorFont;

  authorLines.forEach(aline => {
   ctx.fillText(aline, width / 2 + twidth / 2 - arects[aind++].width, height / 2 - theight / 2 + cvert);
   cvert += aheight + 3;
  });
  
  const outputFileName = getUniqueFileName(outputDir, 'quote', 'png');
  const outputPath = path.join(outputDir, outputFileName);
  
  const buf = canvas.toBuffer('image/png');
  await wf.writeFile(path.resolve(outputPath), await buf);
  console.log('image written');
  
  // Send the image as a response
  res.sendFile(outputPath);
 } catch (error) {
  console.error('Error: ', error.message);
  console.error('Stack: ', error.stack);
  res.status(500).send(error.message);
 }
});

function getUniqueFileName(dir, prefix, extension) {
 let index = 0;
 let fileName = `${prefix}${index}.${extension}`;
 while (fs.existsSync(path.join(dir, fileName))) {
  index++;
  fileName = `${prefix}${index}.${extension}`;
 }
 return fileName;
}

app.listen(port, () => {
 console.log(`Server is running on port ${port}`);
});
