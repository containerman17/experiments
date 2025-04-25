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
      curve: 'secp256k1'//ed25519 or secp256k1
    }
  }));
  console.log('node', node);
  const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from(node.privateKeyBytes || []));

  debugger;
  console.log('keyPair', keyPair);
  console.log('secp256k1.getPublicKey(keyPair.secretKey)', secp256k1.getPublicKey(Uint8Array.from([...keyPair.secretKey])));

  switch (request.method) {
    case 'hello':
      return snap.request({
        method: 'snap_dialog',
        params: {
          type: 'confirmation',
          content: (
            <Box>
              <Text>
                PubKey original: {/*utils.bufferToHex(keyPair.publicKey)*/}
              </Text>
              <Text>
                PubKey from avalanchejs: {utils.bufferToHex(secp256k1.getPublicKey(keyPair.secretKey))}
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
