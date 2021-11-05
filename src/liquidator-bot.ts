import { BN, Provider, Wallet } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	ClearingHouse,
	ClearingHouseUser,
	initialize,
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


    // 1. load users

    const users: ClearingHouseUser[] = [];

    const usersSeen = new Set<string>();
    const updateUserAccounts = async () => {
        console.log('Checking if there are new user accounts');
        const programUserAccounts = await clearingHouse.program.account.user.all();
        let numNewUserAccounts = 0;
        for (const programUserAccount of programUserAccounts) {
            const userAccountPubkey = programUserAccount.publicKey.toString();
            if (usersSeen.has(userAccountPubkey)) {
                continue;
            }
            const user = ClearingHouseUser.from(
                clearingHouse,
                programUserAccount.account.authority
            );
            await user.subscribe();
            users.push(user);
            usersSeen.add(userAccountPubkey);
            numNewUserAccounts += 1;
        }
        console.log(
            'num user accounts:',
            users.length,
            '(',
            numNewUserAccounts,
            ' new )'
        );
    };

    await updateUserAccounts();

    // 2. check for liquidatable users
    for (const user of users) {
        const [canLiquidate] = user.canBeLiquidated();
        if (canLiquidate) {
            const liquidateeUserAccountPublicKey =
                await user.getUserAccountPublicKey();

            try {
                clearingHouse
                    .liquidate(liquidateeUserAccountPublicKey)
                    .then((tx) => {
                        console.log(`Liquidated user: ${user.authority} Tx: ${tx}`);
                    });
            } catch (e) {
                console.log(e);
            }
        }
    }

}

main()



