const { validate: uuidValidate } = require('uuid');
const log = require('loglevel');
const axios = require('axios');
const fs = require('fs').promises;
const Wallet = require('../models/Wallet');
const Session = require('../infra/database/Session');
const Token = require('../models/Token');
const Transfer = require('../models/Transfer');
const HttpError = require('../utils/HttpError');

class WalletService {
  constructor() {
    this._session = new Session();
    this._wallet = new Wallet(this._session);
  }

  async getSubWallets(id) {
    return this._wallet.getSubWallets(id);
  }

  async getById(id) {
    return this._wallet.getById(id);
  }

  async getByName(name) {
    return this._wallet.getByName(name);
  }

  async getWallet(walletId) {
    return this._wallet.getWallet(walletId);
  }

  async getByIdOrName(idOrName) {
    let wallet;
    if (uuidValidate(idOrName)) {
      wallet = await this.getById(idOrName);
    } else {
      wallet = await this.getByName(idOrName);
    }
    return wallet;
  }

  async createWallet(loggedInWalletId, wallet, about) {
    try {
      await this._session.beginTransaction();

      const addedWallet = await this._wallet.createWallet(
        loggedInWalletId,
        wallet,
        about,
      );

      await this._session.commitTransaction();

      return {
        id: addedWallet.id,
        wallet: addedWallet.name,
        about: addedWallet.about,
      };
    } catch (e) {
      if (this._session.isTransactionInProgress()) {
        await this._session.rollbackTransaction();
      }
      throw e;
    }
  }

  async getAllWallets(
    id,
    limitOptions,
    name,
    sort_by,
    order,
    created_at_start_date,
    created_at_end_date,
    getTokenCount = true,
    getWalletCount = true,
  ) {
    if (getTokenCount) {
      const token = new Token(this._session);
      const { wallets, count } = await this._wallet.getAllWallets(
        id,
        limitOptions,
        name,
        sort_by,
        order,
        created_at_start_date,
        created_at_end_date,
        getWalletCount,
      );
      return {
        wallets: await Promise.all(
          wallets.map(async (wallet) => {
            const json = { ...wallet };
            json.tokens_in_wallet = await token.countTokenByWallet(wallet.id);
            return json;
          }),
        ),
        count,
      };
    }
    return this._wallet.getAllWallets(
      id,
      limitOptions,
      name,
      sort_by,
      order,
      created_at_start_date,
      created_at_end_date,
      getWalletCount,
    );
  }

  async hasControlOver(parentId, childId) {
    return this._wallet.hasControlOver(parentId, childId);
  }

  async batchCreateWallet(
    sender_wallet,
    token_transfer_amount_default,
    wallet_id,
    csvJson,
    filePath,
  ) {
    try {
      let senderWallet;
      if (sender_wallet) senderWallet = await this.getByName(sender_wallet);

      const walletPromises = [];
      let totalAmountToTransfer = 0;

      // eslint-disable-next-line no-restricted-syntax
      for (const {
        wallet_name,
        token_transfer_amount_overwrite,
        extra_wallet_data_about,
      } of csvJson) {
        if (token_transfer_amount_overwrite && !sender_wallet) {
          throw new HttpError(422, 'sender_wallet is required for transfer.');
        }
        const amount =
          token_transfer_amount_overwrite || token_transfer_amount_default;
        if (amount) totalAmountToTransfer += +amount;

        walletPromises.push(
          this.createWallet(wallet_id, wallet_name, extra_wallet_data_about),
        );
      }

      const tokenModel = new Token(this._session);

      let walletsCreatedCount = 0;
      const walletsAlreadyExistsFailureCount = [];
      let walletsOtherFailureCount = 0;
      const walletsCreated = [];

      const walletsPromise = await Promise.allSettled(walletPromises);

      let tokenCount = 0;
      if (senderWallet)
        tokenCount = await tokenModel.countTokenByWallet(senderWallet.id);
      if (totalAmountToTransfer > tokenCount) {
        throw new HttpError(409, 'Sender does not have enough tokens.');
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const { status, value, reason } of walletsPromise) {
        if (status === 'fulfilled') {
          walletsCreated.push(value);
          walletsCreatedCount += 1;
        } else if (reason.toString().match(/.*already.*exists/g)) {
          walletsAlreadyExistsFailureCount.push(
            reason.toString().split('Error: ')[1],
          );
        } else {
          walletsOtherFailureCount += 1;
        }
      }

      const transferModel = new Transfer(this._session);
      const extraWalletInformation = [];

      // eslint-disable-next-line no-restricted-syntax
      for (const wallet of walletsCreated) {
        const receiverWallet = await this.getByName(wallet.wallet);
        const walletDetails = csvJson.find(
          (w) => w.wallet_name === wallet.wallet,
        );

        const {
          extra_wallet_data_logo_url,
          extra_wallet_data_cover_url,
        } = walletDetails;

        if (extra_wallet_data_logo_url || extra_wallet_data_cover_url) {
          extraWalletInformation.push({
            walletId: wallet.id,
            name: wallet.name,
            walletLogoUrl: extra_wallet_data_logo_url,
            walletCoverUrl: extra_wallet_data_cover_url,
          });
        }

        await this._session.beginTransaction();

        const amountToTransfer =
          walletDetails.token_transfer_amount_overwrite ||
          token_transfer_amount_default;
        if (amountToTransfer) {
          // claim is false for now
          await transferModel.transferBundle(
            wallet_id,
            senderWallet,
            receiverWallet,
            amountToTransfer,
            false,
          );
        }

        await this._session.commitTransaction();
      }

      await fs.unlink(filePath);

      const walletConfigPromises = [];

      if (extraWalletInformation.length) {
        // eslint-disable-next-line no-restricted-syntax
        for (const {
          walletId,
          walletLogoUrl,
          walletCoverUrl,
          name,
        } of extraWalletInformation) {
          walletConfigPromises.push(
            this.addWalletToMapConfig({
              walletId,
              walletCoverUrl,
              walletLogoUrl,
              name,
            }),
          );
        }
      }

      const walletConfigResults = await Promise.allSettled(
        walletConfigPromises,
      );

      let extraWalletInformationSaved = 0;
      const extraWalletInformationNotSaved = [];

      // eslint-disable-next-line no-restricted-syntax
      for (const { status, reason } of walletConfigResults) {
        if (status === 'fulfilled') {
          extraWalletInformationSaved += 1;
        } else {
          extraWalletInformationNotSaved.push(reason);
        }
      }

      const result = {
        wallets_created: walletsCreatedCount,
        wallets_already_exists: walletsAlreadyExistsFailureCount,
        wallet_other_failure_count: walletsOtherFailureCount,
        extra_wallet_information_saved: extraWalletInformationSaved,
        extra_wallet_information_not_saved: extraWalletInformationNotSaved,
      };

      return result;
    } catch (e) {
      if (this._session.isTransactionInProgress()) {
        await this._session.rollbackTransaction();
      }
      await fs.unlink(filePath);
      throw e;
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async addWalletToMapConfig({
    walletId,
    walletLogoUrl,
    walletCoverUrl,
    name,
  }) {
    const MAP_CONFIG_API_URL =
      process.env.MAP_CONFIG_API_URL ||
      'http://treetracker-map-config-api.webmap-config';
    try {
      const response = await axios.post(`${MAP_CONFIG_API_URL}/config`, {
        name: 'extra-wallet',
        ref_uuid: walletId,
        ref_id: walletId,
        data: {
          ...(walletLogoUrl && {
            logo_url: walletLogoUrl,
          }),
          ...(walletCoverUrl && {
            cover_url: walletCoverUrl,
          }),
        },
      });
      return response.body;
    } catch (e) {
      log.debug('map config API error:', e);
      throw new Error(`${name} webmap config addition failed, ${e.toString()}`);
    }
  }

  async batchTransferWallet(
    sender_wallet,
    token_transfer_amount_default,
    wallet_id,
    csvJson,
    filePath,
  ) {
    try {
      await this._session.beginTransaction();

      const senderWallet = await this.getByName(sender_wallet);

      const recipientWallets = [];
      let totalAmountToTransfer = 0;

      // eslint-disable-next-line no-restricted-syntax
      for (const { wallet_name, token_transfer_amount_overwrite } of csvJson) {
        const amount =
          token_transfer_amount_overwrite || token_transfer_amount_default;
        if (amount && !sender_wallet) {
          throw new HttpError(422, 'sender_wallet is required for transfer.');
        }
        if (amount) {
          totalAmountToTransfer += +amount;
        }
        const walletDetails = await this.getByName(wallet_name);
        recipientWallets.push({ amount, walletDetails });
      }

      const tokenModel = new Token(this._session);
      const tokenCount = await tokenModel.countTokenByWallet(senderWallet.id);

      if (totalAmountToTransfer > tokenCount)
        throw new HttpError(422, 'sender does not have enough tokens');

      const transferModel = new Transfer(this._session);

      // eslint-disable-next-line no-restricted-syntax
      for (const { walletDetails, amount } of recipientWallets) {
        if (amount) {
          // claim is false for now
          await transferModel.transferBundle(
            wallet_id,
            senderWallet,
            walletDetails,
            amount,
            false,
          );
        }
      }

      await this._session.commitTransaction();

      await fs.unlink(filePath);

      return {
        message: 'Batch transfer successful',
      };
    } catch (e) {
      await this._session.rollbackTransaction();
      await fs.unlink(filePath);
      throw e;
    }
  }
}

module.exports = WalletService;
