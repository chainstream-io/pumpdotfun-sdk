import {
  Commitment,
  Connection,
  Finality,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { Program, Provider } from "@coral-xyz/anchor";
import { GlobalAccount } from "./globalAccount.js";
import {
  CompleteEvent,
  CreateEvent,
  CreateTokenMetadata,
  PriorityFee,
  PumpFunEventHandlers,
  PumpFunEventType,
  SetParamsEvent,
  TradeEvent,
  TransactionResult,
} from "./types.js";
import {
  toCompleteEvent,
  toCreateEvent,
  toSetParamsEvent,
  toTradeEvent,
} from "./events.js";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { BondingCurveAccount } from "./bondingCurveAccount.js";
import { BN } from "bn.js";
import {
  DEFAULT_COMMITMENT,
  DEFAULT_FINALITY,
  calculateWithSlippageBuy,
  calculateWithSlippageSell,
  sendTx,
} from "./util.js";
import { PumpFun, IDL } from "./IDL/index.js";
const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const EVENT_AUTHORITY_ID = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";
const SYSVAR_RENT_ID = "SysvarRent111111111111111111111111111111111";

export const GLOBAL_ACCOUNT_SEED = "global";
export const MINT_AUTHORITY_SEED = "mint-authority";
export const BONDING_CURVE_SEED = "bonding-curve";
export const METADATA_SEED = "metadata";
export const EVENT_AUTHORITY_SEED = "__event_authority";

export const DEFAULT_DECIMALS = 6;

export class PumpFunSDK {
  public program: Program<PumpFun>;
  public connection: Connection;
  constructor(provider?: Provider) {
    this.program = new Program<PumpFun>(IDL as PumpFun, provider);
    this.connection = this.program.provider.connection;
  }

  async createAndBuy(
    creator: Keypair,
    mint: Keypair,
    createTokenMetadata: CreateTokenMetadata,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);

    let createTx = await this.getCreateInstructions(
      creator.publicKey,
      createTokenMetadata.name,
      createTokenMetadata.symbol,
      tokenMetadata.metadataUri,
      mint
    );

    let newTx = new Transaction().add(createTx);

    if (buyAmountSol > 0) {
      const globalAccount = await this.getGlobalAccount(commitment);
      const buyAmount = globalAccount.getInitialBuyPrice(buyAmountSol);
      const buyAmountWithSlippage = calculateWithSlippageBuy(
        buyAmountSol,
        slippageBasisPoints
      );

      const buyTx = await this.getBuyInstructions(
        creator.publicKey,
        mint.publicKey,
        globalAccount.feeRecipient,
        buyAmount,
        buyAmountWithSlippage
      );

      newTx.add(buyTx);
    }

    let createResults = await sendTx(
      this.connection,
      newTx,
      creator.publicKey,
      [creator, mint],
      priorityFees,
      commitment,
      finality
    );
    return createResults;
  }

  async buy(
    buyer: Keypair,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    // Get bonding curve account
    const bondingCurvePDA = this.getBondingCurvePDA(mint);
    const bondingAccount = await this.getBondingCurveAccount(mint, commitment);
    if (!bondingAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }

    // Get global account
    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );
    const globalAccount = await this.getGlobalAccount(commitment);

    // Calculate buy amount
    const buyAmount = bondingAccount.getBuyPrice(buyAmountSol);
    const buyAmountWithSlippage = calculateWithSlippageBuy(
      buyAmountSol,
      slippageBasisPoints
    );

    // Get the associated token accounts
    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );
    const associatedUser = await getAssociatedTokenAddress(
      mint,
      buyer.publicKey,
      false
    );

    // Get bonding curve account info to extract creator 
    const bondingAccountInfo = await this.connection.getAccountInfo(bondingCurvePDA, commitment);
    if (!bondingAccountInfo) {
      throw new Error(`Bonding account info not found: ${bondingCurvePDA.toBase58()}`);
    }

    // Creator is at offset 49 (after 8 bytes discriminator, 5 BNs of 8 bytes each, and 1 byte boolean)
    const creatorBytes = bondingAccountInfo.data.slice(49, 49 + 32);
    const creator = new PublicKey(creatorBytes);
    console.log("Creator from bonding curve:", creator.toString());

    // Get the creator vault PDA
    const [creatorVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      this.program.programId
    );
    console.log("Creator vault PDA:", creatorVaultPda.toString());

    // Get event authority PDA
    const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.program.programId
    );

    // Create a new transaction
    let transaction = new Transaction();

    // Add token account creation instruction if needed
    try {
      await getAccount(this.connection, associatedUser, commitment);
    } catch (e) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          buyer.publicKey,
          associatedUser,
          buyer.publicKey,
          mint
        )
      );
    }

    // Create buy instruction data
    const discriminator = [102, 6, 61, 18, 1, 218, 235, 234]; // buy instruction discriminator
    const amountData = Buffer.alloc(8);
    amountData.writeBigUInt64LE(BigInt(buyAmount.toString()), 0);
    const slippageData = Buffer.alloc(8);
    slippageData.writeBigUInt64LE(BigInt(buyAmountWithSlippage.toString()), 0);
    const instructionData = Buffer.from([
      ...discriminator,
      ...Array.from(amountData),
      ...Array.from(slippageData)
    ]);

    // Create accounts array in the exact order from buy_token_fixed.ts
    const accounts = [
      { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
      { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedUser, isSigner: false, isWritable: true },
      { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }, // SystemProgram
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // TokenProgram
      { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
      { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: this.program.programId, isSigner: false, isWritable: false }
    ];

    // Add the buy instruction (manually created to ensure correct account order)
    transaction.add(
      new TransactionInstruction({
        keys: accounts,
        programId: this.program.programId,
        data: instructionData
      })
    );

    // Send the transaction
    return await sendTx(
      this.connection,
      transaction,
      buyer.publicKey,
      [buyer],
      priorityFees,
      commitment,
      finality
    );

  }

  async sell(
    seller: Keypair,
    mint: PublicKey,
    sellTokenAmount: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee,
    commitment: Commitment = DEFAULT_COMMITMENT,
    finality: Finality = DEFAULT_FINALITY
  ): Promise<TransactionResult> {
    // Get bonding curve account
    const bondingCurvePDA = this.getBondingCurvePDA(mint);
    const bondingAccount = await this.getBondingCurveAccount(mint, commitment);
    if (!bondingAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }

    // Get global account
    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );
    const globalAccount = await this.getGlobalAccount(commitment);

    // Calculate sell amount and slippage
    // Get exact price from bonding curve
    const minSolOutput = bondingAccount.getSellPrice(
      sellTokenAmount,
      globalAccount.feeBasisPoints
    );

    // Calculate with more aggressive slippage by directly decreasing the value
    // Reduce by expected calculation gap (from logs) plus 1 for safety
    const slippageAmount = (minSolOutput * slippageBasisPoints) / 10000n;
    const sellAmountWithSlippage = minSolOutput - slippageAmount;

    // Add logging for debugging
    console.log("Sell calculation:", {
        exactAmount: minSolOutput.toString(),
        slippageAmount: slippageAmount.toString(),
        minimumReceived: sellAmountWithSlippage.toString(),
        slippagePercent: `${Number(slippageBasisPoints) / 100}%`
    });

    // Ensure minimum value
    if (sellAmountWithSlippage <= 0n) {
        throw new Error("Calculated sell amount with slippage is too low");
    }

    // Get the associated token accounts
    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );
    const sellerPublicKey = seller.publicKey;
    const associatedUser = await getAssociatedTokenAddress(
      mint,
      sellerPublicKey,
      false
    );


    // Get bonding curve account info to extract creator 
    const bondingAccountInfo = await this.connection.getAccountInfo(bondingCurvePDA, commitment);
    if (!bondingAccountInfo) {
      throw new Error(`Bonding account info not found: ${bondingCurvePDA.toBase58()}`);
    }

    // Creator is at offset 49 (after 8 bytes discriminator, 5 u64 fields at 8 bytes each, 1 byte boolean)
    const creatorBytes = bondingAccountInfo.data.slice(49, 49 + 32);
    const creator = new PublicKey(creatorBytes);
    console.log("Creator from bonding curve:", creator.toString());

    // Get the creator vault PDA
    const [creatorVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      this.program.programId
    );
    console.log("Creator vault PDA:", creatorVaultPda.toString());

    // Get event authority PDA
    const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(EVENT_AUTHORITY_SEED)],
      this.program.programId
    );

    // Create a new transaction
    let transaction = new Transaction();

    // Create accounts array in the exact same order as specified in the official IDL
    const accounts = [
      { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
      { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedUser, isSigner: false, isWritable: true },
      { pubkey: sellerPublicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: this.program.programId, isSigner: false, isWritable: false }
    ];

    // Create sell instruction using IDL
    let ix = await this.program.methods
      .sell(
        new BN(sellTokenAmount.toString()),
        new BN(sellAmountWithSlippage.toString())
      )
      .accounts({
        global: globalAccountPDA,
        feeRecipient: globalAccount.feeRecipient,
        mint: mint,
        bondingCurve: bondingCurvePDA,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: associatedUser,
        user: sellerPublicKey,
        systemProgram: new PublicKey(SYSTEM_PROGRAM_ID),
        creatorVault: creatorVaultPda,
        tokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
        eventAuthority: eventAuthorityPda,
        program: this.program.programId
      } as any)
      .instruction();

    transaction.add(ix);

    // Send the transaction
    return await sendTx(
      this.connection,
      transaction,
      sellerPublicKey,
      [seller],
      priorityFees,
      commitment,
      finality
    );
  }

  //create token instructions
  async getCreateInstructions(
    creator: PublicKey,
    name: string,
    symbol: string,
    uri: string,
    mint: Keypair
  ) {
    const mplTokenMetadata = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);

    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(METADATA_SEED),
        mplTokenMetadata.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      mplTokenMetadata
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint.publicKey,
      this.getBondingCurvePDA(mint.publicKey),
      true
    );

    return this.program.methods
      .create(name, symbol, uri, creator)
      .accounts({
        mint: mint.publicKey,
        associatedBondingCurve: associatedBondingCurve,
        metadata: metadataPDA,
        user: creator,
      } as any)
      .signers([mint])
      .transaction();
  }

  async getBuyInstructionsBySolAmount(
    buyer: PublicKey,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    let bondingCurveAccount = await this.getBondingCurveAccount(
      mint,
      commitment
    );
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }

    let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
    let buyAmountWithSlippage = calculateWithSlippageBuy(
      buyAmountSol,
      slippageBasisPoints
    );

    let globalAccount = await this.getGlobalAccount(commitment);

    return await this.getBuyInstructions(
      buyer,
      mint,
      globalAccount.feeRecipient,
      buyAmount,
      buyAmountWithSlippage
    );
  }

  //buy
  async getBuyInstructions(
    buyer: PublicKey,
    mint: PublicKey,
    feeRecipient: PublicKey,
    amount: bigint,
    solAmount: bigint,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    const bondingCurvePDA = this.getBondingCurvePDA(mint);
    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );

    const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);

    // Get bonding curve account info to extract the creator
    const bondingAccountInfo = await this.connection.getAccountInfo(bondingCurvePDA, commitment);
    if (!bondingAccountInfo) {
      throw new Error(`Bonding account info not found: ${bondingCurvePDA.toBase58()}`);
    }

    // Creator is at offset 49 (after 8 bytes discriminator, 5 BNs of 8 bytes each, and 1 byte boolean)
    const creatorBytes = bondingAccountInfo.data.slice(49, 49 + 32);
    const creator = new PublicKey(creatorBytes);
    console.log("Creator from bonding curve:", creator.toString());

    // Get the creator vault PDA
    const [creatorVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      this.program.programId
    );
    console.log("Creator vault PDA:", creatorVaultPda.toString());

    // Get event authority PDA
    const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.program.programId
    );


    let transaction = new Transaction();

    try {
      await getAccount(this.connection, associatedUser, commitment);
    } catch (e) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          buyer,
          associatedUser,
          buyer,
          mint
        )
      );
    }

    // Get global account PDA
    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );

    // Build and add the buy instruction with the correct accounts
    transaction.add(
      await this.program.methods
        .buy(new BN(amount.toString()), new BN(solAmount.toString()))
        .accounts({
          global: globalAccountPDA,
          fee_recipient: feeRecipient,
          mint: mint,
          bonding_curve: bondingCurvePDA,
          associated_bonding_curve: associatedBondingCurve,
          associated_user: associatedUser,
          user: buyer,
          system_program: new PublicKey(SYSTEM_PROGRAM_ID),
          token_program: new PublicKey(TOKEN_PROGRAM_ID),
          creator_vault: creatorVaultPda,
          event_authority: eventAuthorityPda,
          program: this.program.programId
        } as any)
        .transaction()
    );

    return transaction;
  }

  //sell
  async getSellInstructionsByTokenAmount(
    seller: PublicKey,
    mint: PublicKey,
    sellTokenAmount: bigint,
    slippageBasisPoints: bigint = 500n,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    let bondingCurveAccount = await this.getBondingCurveAccount(
      mint,
      commitment
    );
    if (!bondingCurveAccount) {
      throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
    }

    let globalAccount = await this.getGlobalAccount(commitment);

    // Get exact price from bonding curve
    const minSolOutput = bondingCurveAccount.getSellPrice(
      sellTokenAmount,
      globalAccount.feeBasisPoints
    );

    // Calculate with more aggressive slippage by directly decreasing the value
    // Reduce by expected calculation gap (from logs) plus 1 for safety
    let sellAmountWithSlippage: bigint;
    if (minSolOutput > 2n) {
      // Apply a direct reduction to ensure we get below the expected value
      sellAmountWithSlippage = minSolOutput - 2n;
    } else {
      // For very small amounts, use a minimum of 1
      sellAmountWithSlippage = 1n;
    }

    console.log(`getSellInstructionsByTokenAmount - amount=${sellTokenAmount}, exactOutput=${minSolOutput}, withSlippage=${sellAmountWithSlippage}`);

    return await this.getSellInstructions(
      seller,
      mint,
      globalAccount.feeRecipient,
      sellTokenAmount,
      sellAmountWithSlippage
    );
  }

  async getSellInstructions(
    seller: PublicKey,
    mint: PublicKey,
    feeRecipient: PublicKey,
    amount: bigint,
    minSolOutput: bigint
  ) {
    const bondingCurvePDA = this.getBondingCurvePDA(mint);

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );

    const associatedUser = await getAssociatedTokenAddress(mint, seller, false);

    let transaction = new Transaction();

    // Get global account PDA
    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      this.program.programId
    );

    // Get bonding curve account info to extract the creator
    const bondingAccountInfo = await this.connection.getAccountInfo(bondingCurvePDA);
    if (!bondingAccountInfo) {
      throw new Error(`Bonding account info not found: ${bondingCurvePDA.toBase58()}`);
    }

    // Creator is at offset 49 (after 8 bytes discriminator, 5 u64 fields, and 1 byte boolean)
    const creatorBytes = bondingAccountInfo.data.slice(49, 49 + 32);
    const creator = new PublicKey(creatorBytes);
    console.log("Creator from bonding curve:", creator.toString());

    // Create the creator vault PDA using the creator pubkey
    const [creatorVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      this.program.programId
    );
    console.log("Creator vault PDA:", creatorVaultPda.toString());

    // Get event authority PDA
    const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(EVENT_AUTHORITY_SEED)],
      this.program.programId
    );

    // Check IDL for the correct order of accounts
    const accounts = [
      { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedUser, isSigner: false, isWritable: true },
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
      { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: this.program.programId, isSigner: false, isWritable: false }
    ];

    // Create the sell instruction with BN values for amount and minSolOutput
    const instructionData = this.program.coder.instruction.encode("sell", {
      amount: new BN(amount.toString()),
      minSolOutput: new BN(minSolOutput.toString())
    });

    // Add the instruction to the transaction
    transaction.add(
      new TransactionInstruction({
        keys: accounts,
        programId: this.program.programId,
        data: instructionData
      })
    );

    return transaction;
  }

  async getBondingCurveAccount(
    mint: PublicKey,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    const tokenAccount = await this.connection.getAccountInfo(
      this.getBondingCurvePDA(mint),
      commitment
    );
    if (!tokenAccount) {
      return null;
    }
    return BondingCurveAccount.fromBuffer(tokenAccount!.data);
  }

  async getGlobalAccount(commitment: Commitment = DEFAULT_COMMITMENT) {
    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      new PublicKey(PROGRAM_ID)
    );

    const tokenAccount = await this.connection.getAccountInfo(
      globalAccountPDA,
      commitment
    );

    return GlobalAccount.fromBuffer(tokenAccount!.data);
  }

  getBondingCurvePDA(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      this.program.programId
    )[0];
  }

  async createTokenMetadata(create: CreateTokenMetadata) {
    // Validate file
    if (!(create.file instanceof Blob)) {
      throw new Error('File must be a Blob or File object');
    }

    let formData = new FormData();
    formData.append("file", create.file, 'image.png'); // Add filename
    formData.append("name", create.name);
    formData.append("symbol", create.symbol);
    formData.append("description", create.description);
    formData.append("twitter", create.twitter || "");
    formData.append("telegram", create.telegram || "");
    formData.append("website", create.website || "");
    formData.append("showName", "true");

    try {
      const request = await fetch("https://pump.fun/api/ipfs", {
        method: "POST",
        headers: {
          'Accept': 'application/json',
        },
        body: formData,
        credentials: 'same-origin'
      });

      if (request.status === 500) {
        // Try to get more error details
        const errorText = await request.text();
        throw new Error(`Server error (500): ${errorText || 'No error details available'}`);
      }

      if (!request.ok) {
        throw new Error(`HTTP error! status: ${request.status}`);
      }

      const responseText = await request.text();
      if (!responseText) {
        throw new Error('Empty response received from server');
      }

      try {
        return JSON.parse(responseText);
      } catch (e) {
        throw new Error(`Invalid JSON response: ${responseText}`);
      }
    } catch (error) {
      console.error('Error in createTokenMetadata:', error);
      throw error;
    }
  }
  //EVENTS
  addEventListener<T extends PumpFunEventType>(
    eventType: T,
    callback: (
      event: PumpFunEventHandlers[T],
      slot: number,
      signature: string
    ) => void
  ) {
    return this.program.addEventListener(
      eventType,
      (event: any, slot: number, signature: string) => {
        let processedEvent;
        switch (eventType) {
          case "createEvent":
            processedEvent = toCreateEvent(event as CreateEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "tradeEvent":
            processedEvent = toTradeEvent(event as TradeEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "completeEvent":
            processedEvent = toCompleteEvent(event as CompleteEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "setParamsEvent":
            processedEvent = toSetParamsEvent(event as SetParamsEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          default:
            console.error("Unhandled event type:", eventType);
        }
      }
    );
  }

  removeEventListener(eventId: number) {
    this.program.removeEventListener(eventId);
  }
}
