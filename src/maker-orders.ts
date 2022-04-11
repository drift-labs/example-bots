import * as anchor from "@project-serum/anchor";
import { Provider } from "@project-serum/anchor";
import {
    Admin,
    BN,
    AMM_RESERVE_PRECISION,
    calculateMarkPrice,
    getLimitOrderParams,
    PositionDirection,
    ClearingHouse,
    ClearingHouseUser,
    ZERO,
    OrderParams,
    isVariant,
    Markets,
    initialize,
    DriftEnv,
    // Wallet,
} from "@drift-labs/sdk";

import dotenv = require("dotenv");
import { PublicKey, TransactionSignature, Transaction } from "@solana/web3.js";

dotenv.config();

async function cancelAllThenPlaceNewOrders(
    clearingHouse: ClearingHouse,
    clearingHouseUser: ClearingHouseUser,
    orderParams: OrderParams[],
    discountToken?: PublicKey,
    referrer?: PublicKey
): Promise<TransactionSignature> {
    const instructions: anchor.web3.TransactionInstruction[] = [];
    const userOrdersAccountExists =
        await clearingHouse.userOrdersAccountExists();

    const orderAccount = clearingHouseUser.getUserOrdersAccount();
    let numOpenOrders = 0;
    for (const order of orderAccount.orders) {
        if (!isVariant(order.status, "init")) {
            numOpenOrders += 1;
        }
    }
    const markets = clearingHouse.getMarketsAccount();

    const markets_with_position = clearingHouseUser
        .getUserPositionsAccount()
        .positions.map((position) => {
            return position.marketIndex.toString();
        });

    // cancel all open orders before placing new ones
    // if (userOrdersAccountExists && numOpenOrders > 0) {
    //     const oracles = clearingHouseUser
    //         .getUserPositionsAccount()
    //         .positions.map((position) => {
    //             return markets.markets[position.marketIndex.toString()].amm
    //                 .oracle;
    //         });
    //     console.log("canceling all open orders (", numOpenOrders, ")");

    //     // todo: check if all orders cannot be filled at market first
    //     instructions.push(await clearingHouse.getCancelAllOrdersIx(oracles));
    // }

    console.log("placing", orderParams.length, "new orders");

    // post list of orders
    for (const orderParm of orderParams) {
        const orderMarket = orderParm.marketIndex.toString();

        // convient check/message for too many positions/orders across markets
        if (
            markets_with_position.length >= 5 &&
            !markets_with_position.includes(orderMarket)
        ) {
            throw new Error(
                "Cannot place an order for additional MarketIndex=" +
                    orderMarket +
                    ". The max number of cross margined positions per account is 5."
            );
        }

        instructions.push(
            await clearingHouse.getPlaceOrderIx(
                orderParm,
                discountToken,
                referrer
            )
        );
    }
    const tx = new Transaction();
    for (const instruction of instructions) {
        tx.add(instruction);
    }

    // send all of above in single atomic transaction
    let txResult = await clearingHouse.txSender.send(
        tx,
        [], // additionalSigners
        clearingHouse.opts // transaction ConfirmOptions
    );

    return txResult;
}

function constructFloatingMMSpread(
    clearingHouse: ClearingHouse,
    marketIndex: BN,
    baseAssetAmount: BN,
    postOnly: boolean
) {
    const market = clearingHouse.getMarket(marketIndex);
    const limitPrice = ZERO;
    // const limitPrice = market.amm.lastMarkPriceTwap;

    // 10 bps
    const offset = market.amm.lastMarkPriceTwap.div(new BN(-1000));

    //bid
    const orderParams = getLimitOrderParams(
        marketIndex,
        PositionDirection.LONG,
        baseAssetAmount,
        limitPrice,
        false,
        undefined,
        undefined,
        0,
        postOnly,
        offset,
        false //ioc
    );

    // ask
    const orderParams2 = getLimitOrderParams(
        marketIndex,
        PositionDirection.SHORT,
        baseAssetAmount,
        limitPrice,
        false,
        undefined,
        undefined,
        0,
        postOnly,
        offset.mul(new BN(-1)),
        false //ioc
    );

    return [orderParams, orderParams2];
}

function constructFixedMMSpread(
    clearingHouse: ClearingHouse,
    marketIndex: BN,
    baseAssetAmount: BN,
    postOnly: boolean
) {
    const market = clearingHouse.getMarket(marketIndex);
    const limitPrice = calculateMarkPrice(market);
    const offset = limitPrice.div(new BN(10000)); // 1 bps

    //bid
    const orderParams = getLimitOrderParams(
        marketIndex,
        PositionDirection.LONG,
        baseAssetAmount,
        limitPrice.sub(offset), // price
        false, // reduce only
        undefined, //discount (not currently supported)
        undefined, // referfee (not currently supported)
        0, // user Order Id
        postOnly,
        ZERO,
        false //ioc
    );

    // ask
    const orderParams2 = getLimitOrderParams(
        marketIndex,
        PositionDirection.SHORT,
        baseAssetAmount,
        limitPrice.add(offset),
        false,
        undefined,
        undefined,
        0,
        postOnly,
        ZERO,
        false //ioc
    );

    return [orderParams, orderParams2];
}

async function makeMarket(provider: Provider, marketIndex: BN) {
    const connection = provider.connection;
    const sdkConfig = initialize({ env: "devnet" as DriftEnv }); //change to "mainnet-beta" for production
    const clearingHousePublicKey = new PublicKey(
        sdkConfig.CLEARING_HOUSE_PROGRAM_ID
    );
    const clearingHouse = Admin.from(
        connection,
        provider.wallet,
        clearingHousePublicKey
    );
    await clearingHouse.subscribe();

    const user = ClearingHouseUser.from(
        clearingHouse,
        provider.wallet.publicKey
    );
    await user.subscribe();

    console.log(
        "User Authority:",
        provider.wallet.publicKey.toString(),
        "| ClearingHouse ProgramID:",
        clearingHousePublicKey.toString()
    );

    // Drift Protocol Maker Order Example:

    // The orders are placed atomically (all or nothing) and are by default Post Only (0 protocol fee if filled)
    // the transaction will fail if the market moves s.t any order can be filled when recieved. this guarantees
    // that the spread will be posted.

    const baseAssetAmount = AMM_RESERVE_PRECISION; // AMM_RESERVE_PRECISION (1e13) represents 1 base asset (SOL/BTC/etc)
    const postOnly = true; // 0 protocol fee (but also no price improvement)

    // Places a Bid/Ask 1 bp from the current Mark Price for the selected Market
    //
    //      e.g. Long  1 SOL @ <Market Price * .9999>
    //      e.g. Short 1 SOL @ <Market Price * 1.0001>
    //          ( for a $100 contract this is a 2 cent spread )
    const bidAskOrdersParams: OrderParams[] = constructFixedMMSpread(
        clearingHouse,
        marketIndex,
        baseAssetAmount,
        postOnly
    );
    let tx = await cancelAllThenPlaceNewOrders(
        clearingHouse,
        user,
        bidAskOrdersParams
    );

    console.log(tx);

    // await clearingHouse.cancelOrder(new BN(46));
    // await clearingHouse.cancelOrder(new BN(19));
    // await clearingHouse.cancelOrder(new BN(20));

    await clearingHouse.unsubscribe();
}

try {
    if (!process.env.ANCHOR_WALLET) {
        throw new Error(
            "ANCHOR_WALLET env variable must be set. (file path, e.g. ~/.config/solana/<your_wallet>.json)"
        );
    }

    // Get current price
    const solMarketInfo = Markets.find(
        (market) => market.baseAssetSymbol === "SOL"
    );

    const marketIndex = solMarketInfo.marketIndex;
    const rpcAddress = "https://api.devnet.solana.com"; // for devnet; https://api.mainnet-beta.solana.com for mainnet;

    makeMarket(anchor.Provider.local(rpcAddress), marketIndex);
} catch (e) {
    console.error(e);
}
