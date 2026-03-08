'use strict';
// Jest manual mock for acme-client — prevents real ACME network calls in tests.
const crypto = require('crypto');

module.exports = {
  forge: {
    createPrivateKey: jest.fn().mockImplementation(() =>
      Promise.resolve(crypto.generateKeyPairSync('rsa', { modulusLength: 512 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    ),
    createCsr: jest.fn().mockResolvedValue(['mock-key', 'mock-csr'])
  },
  directory: {
    letsencrypt: {
      staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      production: 'https://acme-v02.api.letsencrypt.org/directory'
    }
  },
  Client: jest.fn().mockImplementation(() => ({
    getAccountUrl: jest.fn().mockResolvedValue('https://acme-v02.api.letsencrypt.org/acme/acct/mock'),
    createAccount: jest.fn().mockResolvedValue({}),
    auto: jest.fn().mockResolvedValue('-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----')
  }))
};
