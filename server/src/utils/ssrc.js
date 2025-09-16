const crypto = require('crypto');

function generateSsrc(streamKey) {
  const hash = crypto.createHash('sha1').update(streamKey).digest();
  return hash.readUInt32BE(0) & 0x7fffffff;
}

module.exports = {
  generateSsrc,
};
