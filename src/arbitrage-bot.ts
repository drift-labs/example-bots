import { BN, Provider, Wallet } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	calculateMarkPrice,
	ClearingHouse,
	ClearingHouseUser,
	initialize,
	Markets,
	PositionDirection,
	convertToNumber,
	calculateTradeSlippage,
	calculateTargetPriceTrade,
	QUOTE_PRECISION,
    MARK_PRICE_PRECISION,
	DriftEnv,
} from '@drift-labs/sdk';

require('dotenv').config();

export const getTokenAddress = (
	mintAddress: string,
	userPubKey: string
): Promise<PublicKey> => {
	return Token.getAssociatedTokenAddress(
		new PublicKey(`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`),
		TOKEN_PROGRAM_ID,
		new PublicKey(mintAddress),
		new PublicKey(userPubKey)
	);
};


async function arbTrade(clearingHouse, marketIndex) {
        const market = clearingHouse.getMarket(marketIndex);

        // arbitrager price gap
        const targetPrice = new BN(250.169 * MARK_PRICE_PRECISION.toNumber());
        const [direction, amount, entryPrice, newMarkPrice] =
                                calculateTargetPriceTrade(
                                    market,
                                    targetPrice,
                                );
    
        // for example: cap trades at $1
        const amountCapped = BN.min(amount, QUOTE_PRECISION); 
                                
        await clearingHouse.openPosition(
            direction,
            amountCapped,
            marketIndex,
            entryPrice
        );
}

const main = async () => {
	// Initialize Drift SDK
	const sdkConfig = initialize({ env: 'devnet' as DriftEnv });

	// Set up the Wallet and Provider
	const privateKey = process.env.BOT_PRIVATE_KEY; // stored as an array string
	const keypair = Keypair.fromSecretKey(
		Uint8Array.from(JSON.parse(privateKey))
	);
	const wallet = new Wallet(keypair);

	// Set up the Connection
	const rpcAddress = 'https://api.devnet.solana.com'// for devnet; https://api.mainnet-beta.solana.com for mainnet;
	const connection = new Connection(rpcAddress);

	// Set up the Provider
	const provider = new Provider(connection, wallet, Provider.defaultOptions());

	// Check SOL Balance
	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	console.log('SOL balance:', lamportsBalance / 10 ** 9);

	// Misc. other things to set up
	const usdcTokenAddress = await getTokenAddress(
		sdkConfig.USDC_MINT_ADDRESS,
		wallet.publicKey.toString()
	);

	// Set up the Drift Clearing House
	const clearingHousePublicKey = new PublicKey(
		sdkConfig.CLEARING_HOUSE_PROGRAM_ID
	);
	const clearingHouse = ClearingHouse.from(
		connection,
		provider.wallet,
		clearingHousePublicKey
	);
	await clearingHouse.subscribe();

	// Get current price
	const solMarketInfo = Markets.find(
		(market) => market.baseAssetSymbol === 'SOL'
	);

    const solMarket = clearingHouse.getMarket(solMarketInfo.marketIndex);

	const currentMarketPrice = calculateMarkPrice(solMarket);

	const formattedPrice = convertToNumber(currentMarketPrice, MARK_PRICE_PRECISION);

	console.log(`Current Market Price is $${formattedPrice}`);

	// Estimate the slippage for a $5000 LONG trade
	const solMarketAccount = clearingHouse.getMarket(solMarketInfo.marketIndex);

	const slippage = convertToNumber(
		calculateTradeSlippage(
			PositionDirection.LONG,
			new BN(5000).mul(QUOTE_PRECISION),
			solMarketAccount
		)[0],
		MARK_PRICE_PRECISION
	);

	console.log(
		`Slippage for a $5000 LONG on the SOL market would be $${slippage}`
	);


	// Set up Clearing House user client
	const user = ClearingHouseUser.from(clearingHouse, wallet.publicKey);

	//// Check if clearing house account exists for the current wallet
	const userAccountExists = await user.exists();

	if (!userAccountExists) {
		//// Create a Clearing House account by Depositing some USDC ($10,000 in this case)
		const depositAmount = new BN(10000).mul(QUOTE_PRECISION);
		try{
		const tx = await clearingHouse.initializeUserAccountAndDepositCollateral(
			depositAmount,
			usdcTokenAddress
		);
			}catch(e){
				throw Error('ERROR: Unable to initializeUserAccountAndDepositCollateral');
			}
	}

	await user.subscribe();

    while(true){
        function sleep(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }

        // await arbTrade(clearingHouse, solMarketInfo.marketIndex);
        console.log('sleeping for 10 seconds...');
        sleep(10000); // wait seconds
    }
};

main();
