module.exports = (fn) => (req, res, next) => {
 Promise.resolve(fn(req, res, next)).catch((error) => {
  console.error('Error: ', error.message);
  console.error('Stack: ', error.stack);
  if (error.code === '23505') {
   return res.status(409).send(error.detail || error.message);
  }
  res.status(500).send(error.message);
 });
};
