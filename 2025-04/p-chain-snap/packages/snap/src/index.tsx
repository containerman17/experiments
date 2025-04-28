import { SLIP10Node } from '@metamask/key-tree';
import type { OnRpcRequestHandler } from '@metamask/snaps-sdk';
import { Box, Text, Bold } from '@metamask/snaps-sdk/jsx';
import nacl from 'tweetnacl';
import { secp256k1, UnsignedTx, utils } from '@avalabs/avalanchejs';

const addSigToAllCreds = async (
  unsignedTx: UnsignedTx,
  privateKey: Uint8Array,
) => {
  const unsignedBytes = unsignedTx.toBytes();
  const publicKey = secp256k1.getPublicKey(privateKey);

  if (!unsignedTx.hasPubkey(publicKey)) {
    return;
  }
  const signature = await secp256k1.sign(unsignedBytes, privateKey);

  for (let i = 0; i < unsignedTx.getCredentials().length; i++) {
    unsignedTx.addSignatureAt(signature, i, 0);
  }
};

/**
 * Handle incoming JSON-RPC requests, sent through `wallet_invokeSnap`.
 *
 * @param args - The request handler args as object.
 * @param args.origin - The origin of the request, e.g., the website that
 * invoked the snap.
 * @param args.request - A validated JSON-RPC request object.
 * @returns The result of `snap_dialog`.
 * @throws If the request method is not valid for this snap.
 */
export const onRpcRequest: OnRpcRequestHandler = async ({
  origin,
  request,
}) => {
  const node = await SLIP10Node.fromJSON(await snap.request({
    method: 'snap_getBip32Entropy',
    params: {
      path: [`m`, `44'`, `9000'`, `0'`],
      curve: 'secp256k1'
    }
  }));

  const secp256k1PrivateKeyBytes = node.privateKeyBytes;

  if (!secp256k1PrivateKeyBytes) {
    throw new Error("Failed to get private key bytes");
  }

  // Use the avalanchejs library directly for secp256k1 operations
  const secp256k1PublicKeyBytes = secp256k1.getPublicKey(secp256k1PrivateKeyBytes);
  const address = utils.formatBech32(
    'fuji',
    secp256k1.publicKeyBytesToAddress(secp256k1PublicKeyBytes),
  );

  console.log('secp256k1 Private Key:', utils.bufferToHex(secp256k1PrivateKeyBytes));
  console.log('secp256k1 Public Key:', utils.bufferToHex(secp256k1PublicKeyBytes));
  console.log('Derived Address:', address);

  switch (request.method) {
    case 'hello':
      return snap.request({
        method: 'snap_dialog',
        params: {
          type: 'confirmation',
          content: (
            <Box>
              <Text>
                PrivateKey: {utils.bufferToHex(secp256k1PrivateKeyBytes)}
              </Text>
              <Text>
                PublicKey: {utils.bufferToHex(secp256k1PublicKeyBytes)}
              </Text>
              <Text>
                Address: {address}
              </Text>
              <Text>
                Expected address is fuji15dhs4ee8cahe52rdslnerpm3an64fsd6qwrztm
              </Text>

              <Text>
                Hello, <Bold>{origin}</Bold>!
              </Text>
              <Text>
                This custom confirmation is just for display purposes.
              </Text>
              <Text>
                But you can edit the snap source code to make it do something,
                if you want to!
              </Text>
            </Box>
          ),
        },
      });
    default:
      throw new Error('Method not found.');
  }
};
