const session = require('express-session');

class SequelizeSessionStore extends session.Store {
  constructor(model) {
    super();
    this.model = model;
  }

  get(sid, callback) {
    this.model.findByPk(sid)
      .then(async record => {
        if (!record) return callback(null, null);
        if (record.expiresAt <= new Date()) {
          await record.destroy();
          return callback(null, null);
        }
        return callback(null, JSON.parse(record.data));
      })
      .catch(callback);
  }

  set(sid, value, callback = () => {}) {
    const expiresAt = value.cookie?.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.model.upsert({ sid, expiresAt, data: JSON.stringify(value) })
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.model.destroy({ where: { sid } })
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, value, callback = () => {}) {
    const expiresAt = value.cookie?.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.model.update({ expiresAt }, { where: { sid } })
      .then(() => callback(null))
      .catch(callback);
  }

  clearExpired() {
    const { Op } = this.model.sequelize.Sequelize;
    return this.model.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
  }
}

module.exports = SequelizeSessionStore;
