class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.senderMappings = new Map();
  }

  createSession(session) {
    const record = {
      ...session,
      status: 'waiting',
      createdAt: Date.now(),
    };
    this.sessions.set(record.streamKey, record);
    return record;
  }

  updateSession(streamKey, updates) {
    const record = this.sessions.get(streamKey);
    if (!record) {
      return null;
    }
    Object.assign(record, updates);
    return record;
  }

  getSession(streamKey) {
    return this.sessions.get(streamKey);
  }

  listSessions() {
    return Array.from(this.sessions.values());
  }

  removeSession(streamKey) {
    this.sessions.delete(streamKey);
    this.senderMappings.delete(streamKey);
  }

  addSender(streamKey, sender) {
    if (!sender) {
      return;
    }
    const list = this.senderMappings.get(streamKey) || [];
    if (!list.some((entry) => entry.sender === sender)) {
      list.push({ sender, firstSeen: Date.now() });
      this.senderMappings.set(streamKey, list);
    }
  }

  getSenderMappings() {
    const mappings = {};
    for (const [streamKey, list] of this.senderMappings.entries()) {
      mappings[streamKey] = list;
    }
    return mappings;
  }

  getMappingStats() {
    let totalSenders = 0;
    let localSenders = 0;
    for (const list of this.senderMappings.values()) {
      totalSenders += list.length;
      localSenders += list.filter(({ sender }) => isPrivateIp(sender.split(':')[0])).length;
    }
    return { totalSenders, localSenders };
  }
}

function isPrivateIp(ip) {
  if (!ip) {
    return false;
  }
  if (ip.startsWith('10.')) {
    return true;
  }
  if (ip.startsWith('192.168.')) {
    return true;
  }
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    return second >= 16 && second <= 31;
  }
  if (ip.startsWith('127.')) {
    return true;
  }
  if (ip === '::1') {
    return true;
  }
  return false;
}

module.exports = SessionStore;
