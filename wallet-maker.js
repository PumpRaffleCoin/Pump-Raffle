import { Keypair } from "@solana/web3.js";
const kp = Keypair.generate();
console.log("TREASURY_PUBLIC_KEY =", kp.publicKey.toBase58());
console.log(
  "TREASURY_SECRET_KEY (paste into .env) =",
  "[" + Array.from(kp.secretKey).join(",") + "]"
);
