function isoTimestamp() {
 return new Date().toISOString().split('.')[0] + 'Z';
}

function levelFor(statusCode) {
 if (statusCode >= 500) return 'ERR';
 if (statusCode >= 400) return 'WRN';
 return 'MSG';
}

module.exports = (req, res, next) => {
 const start = process.hrtime.bigint();

 res.on('finish', () => {
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(
   `${isoTimestamp()} (${levelFor(res.statusCode)}): ${req.method} ${req.originalUrl} - ${res.statusCode} - ${durationMs.toFixed(2)} ms`
  );
 });

 next();
};
