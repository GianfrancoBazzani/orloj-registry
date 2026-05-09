import { z } from "zod";
import { encodeFunctionData } from "viem";

const BASE_URL = "https://sourcify.dev/server";

function solidityTypeToZod(param) {
  const { type, components } = param;

  if (type.endsWith("[]")) {
    return z.array(solidityTypeToZod({ ...param, type: type.slice(0, -2) }));
  }

  const fixedArray = type.match(/^(.+)\[(\d+)\]$/);
  if (fixedArray) {
    return z.array(solidityTypeToZod({ ...param, type: fixedArray[1] })).length(Number(fixedArray[2]));
  }

  if (type === "tuple") {
    const shape = {};
    (components ?? []).forEach((c, i) => {
      shape[c.name || `field${i}`] = solidityTypeToZod(c);
    });
    return z.object(shape);
  }

  if (type === "address") return z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe("Ethereum address");
  if (type === "bool") return z.boolean();
  if (type === "string") return z.string();
  if (type.startsWith("bytes")) return z.string().regex(/^0x([0-9a-fA-F]{2})*$/).describe("Hex-encoded bytes");
  if (type.startsWith("uint") || type.startsWith("int")) return z.string().regex(/^-?\d+$/).describe(`${type} as decimal string`);

  return z.unknown();
}

function canonicalType(param) {
  if (param.type === "tuple") {
    const inner = (param.components ?? []).map(canonicalType).join(",");
    return `(${inner})`;
  }
  return param.type;
}

function functionSignature(fn) {
  return `${fn.name}(${fn.inputs.map(canonicalType).join(",")})`;
}

function argsArray(fn, args) {
  return fn.inputs.map((p, i) => args[p.name || `param${i}`]);
}

export async function getContract(address, chainId, options = {}) {
  const abiAddress = options.abiAddress ?? address;
  const url = `${BASE_URL}/v2/contract/${chainId}/${abiAddress}?fields=abi,userdoc,devdoc,compilation`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();

  const userdocMethods = data.userdoc?.methods ?? {};
  const devdocMethods = data.devdoc?.methods ?? {};
  const name_contract = data.compilation?.name ?? address;
  const contractAddress = address;
  const abi = data.abi;

  const functions = (data.abi ?? [])
    .filter((item) => {
      if (item.type === "event") return !options.ignoreEvents;
      return item.type === "function";
    })
    .map((fn) => {
      const sig = functionSignature(fn);
      const doc = userdocMethods[sig]?.notice ?? devdocMethods[sig]?.details ?? "";

      const inputShape = {};
      fn.inputs.forEach((p, i) => {
        inputShape[p.name || `param${i}`] = solidityTypeToZod(p).describe(p.name || `param${i}`);
      });

      const outputShape = {};
      fn.outputs.forEach((p, i) => {
        outputShape[p.name || `result${i}`] = solidityTypeToZod(p);
      });

      const isView = fn.stateMutability === "view" || fn.stateMutability === "pure";

      if (isView) {
        return {
          name: fn.name,
          doc,
          type: "view",
          input: z.object(inputShape),
          output: z.object(outputShape),
          func: (publicClient, args) =>
            publicClient.readContract({
              address: contractAddress,
              abi,
              functionName: fn.name,
              args: argsArray(fn, args),
            }),
        };
      }

      return {
        name: fn.name,
        doc,
        type: "write",
        input: z.object(inputShape),
        output: z.object(outputShape),
        encodeData: (args) =>
          encodeFunctionData({ abi, functionName: fn.name, args: argsArray(fn, args) }),
        func: (signer, args) =>
          signer.writeContract({
            address: contractAddress,
            abi,
            functionName: fn.name,
            args: argsArray(fn, args),
            account: signer.account,
            chain: signer.chain,
          }),
      };
    });

  return { name_contract, functions };
}
