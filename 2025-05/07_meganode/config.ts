// import pLimit from 'p-limit';
// import pThrottle from 'p-throttle';
// import { fetchAllChains, getCurrentValidators } from "./rpc"

// const allChains = await fetchAllChains()

// console.log(`Found ${allChains.length} chains`)

// const validatedChains: string[] = []
// const unvalidatedChains: string[] = []

// const limit = pLimit(5);
// const throttle = pThrottle({
//     limit: 10,
//     interval: 1000
// });

// const throttledGetValidators = throttle(getCurrentValidators);

// let completed = 0
// async function checkValidated(chainId: string, subnetId: string) {
//     if (chainId === "11111111111111111111111111111111LpoYY") {
//         return
//     }
//     const validators = await throttledGetValidators(subnetId)
//     if (validators.length > 0) {
//         validatedChains.push(chainId)
//     } else {
//         unvalidatedChains.push(chainId)
//     }

//     completed++
//     console.log(`Completed ${completed} of ${allChains.length} chains`)
// }


// await Promise.all(allChains.map(chain => limit(() => checkValidated(chain.blockchainId, chain.subnetId))))

// console.log(`Validated chains: ${validatedChains.length}`)
// console.log(`Unvalidated chains: ${unvalidatedChains.length}`)

// export const chainIds = validatedChains

// console.log(JSON.stringify(validatedChains, null, 2))

export const chainIds = [
    "s1vB7Hv5aCwEdfWGyPtvtuha4Ec8hjE17bkGrqsq8KALDkQE6",
    "2YnwDMW9shSuV6nuYpAhm3DE2KvYJP2GFDvUde6XG8jE5gxvpL",
    "2pzU2j1SdDuAo3XakxVXaics6zURCAMr6NxZo9wgzijVa3Baj",
    "J3MYb3rDARLmB7FrRybinyjKqVTqmerbCr9bAXDatrSaHiLxQ",
    "2bfBt8cBikMAPQER52FLkRDK4WoMhr77rqHz6WxvRCRmt4A7Cs",
    "VxdBzAFifdpG5YqSXYtiUmociBBQ7JLoamKVDuPqmZ5i2KxfC",
    "2XSJa9Guqssjns1PEejrkX2V28KC1ew3y3yQi75tDAxsQzjkYW",
    "2D8KYBxSEyVhM6Yztj1HBr7423xXNoCD4mNmppeco7SQccSjgf",
    "25xjR3fvh7aXkxs36n1xRc3wLUAuqnS1wBxJD1BC4z3y6mHsEV",
    "24gRTyzFmXUPebVwzQHuwU6RFeKHHDxRftRVaSAe7MHRXWxZ4S",
    "Bv235zarDRVyTGPhUUEsfJqCX4nVmdSxkF2bU2BfPV9W3dNe7",
    "2iMvN9SpWRQM8fNJ85qYH1iK91eyqt1CdqX7o2ie8dtcYnycaq",
    "SUDoK9P89PCcguskyof41fZexw7U3zubDP2DZpGf3HbFWwJ4E",
    "2JepXG35p5i21VxbnPx1eWmu5Z5EutcSXVAtcisBBJPTYzAVmB",
    "2J3wrSD3J4ooa2Wanacv9PWZ6hb6dTHVuo1RQnRXx1kbPTbn8H",
    "QgQ2ATB5Ca6US2jur1iPrfBtFDGNSQHXcnSzfv19ZZ2vLZSrk",
    "ZG7cT4B1u3y7piZ9CzfejnTKnNAoehcifbJWUwBqgyD3RuEqK",
    "2X863aybDh9FxQfwhqU3MZJuLMuH8EorG5j1d14zfWkAdMXPc",
    "kyY16vnR3Wc77KCsghGx1c2JM6FRKSP4EUxdfe19qE2az5TPC",
    "2vmiAUCfkXd67jEq2GQhzVgTfNs3tpUP89agEEvnRK7urMVpjb",
    "2SfshBPqRJexmqdWBY2xYSTq2Rp2dDisuax7nQB6GyNqPjSWWY",
    "tjoVGZ7f9FrXhi1QEH2NwHkPtvzmkGMPX6hkypYX6gK5YaXxN",
    "HVPGfG6F8EXsL3bDpE6iVcbaYFyZTcigHxDvpbFGa8P5PeZFg",
    "2AB5dDcGsw86kroZ81AZXzdez3CgA1x9uXkyQDhxr98hjrkVhu",
    "8yyXaeqhBEDc7sJVTecGtdHgXE4y2EJD228SaVvEsU6ZU3Kuv",
    "ajCDtyB1dfjc1AmJDWWDGt8R7r8z14UmhRE8UT53WuY7WfPmD",
    "26Ee4Lm4R1bQbQLQU66exLiWgSC9qdDPJCvFpzVsd3raLrHBGZ",
    "ZuxjNA8QKfcd3254SsFfKFexvPupXic27Z9tMpUiyxcLHFDGs",
    "VDJ7oA16cUEund1G8DZHWjbqEmJeUTyx684QLnaSskgPRVizw",
    "2LFmzhHDKxkreihEtPanVmofuFn63bsh8twnRXEbDhBtCJxURB",
    "2MvLKR8AP3tz1yFQhLRnHBWrXFR4wfojysCHMAGuJVvb8ayRNK",
    "2tig763SuFas5WGk6vsjj8uWzTwq8DKvAN8YgeouwFZe28XjNm",
    "2XCTEc8CfNK9MtQWYMfgNt32QjZsZqq92LH7eTV5xY8YjY44du",
    "2wgBBD7vYiDTvxxzxKnVFW7W3TEe6gz9pKzmxMF7hzn3BTtEjM",
    "26dcgz8T8kfy4L2C7xUini5L8rrefvDhtmSaSnRHPNJ978zVHf",
    "2ZqKyxvovYxFrJxp7ETRZVioem6zkP5Jsbifq7k9GNchma94fC",
    "2CkSqfaCYCoRb8TmEYoamGHp1QpwEkdUQpaLsxYbpULc2YcBWz",
    "2c1BN4N9qEhNmW4yCpeLK24SfjFQLyS1Z7FtgRDaYxZWFUUKxf",
    "2M47TxWHGnhNtq6pM5zPXdATBtuqubxn5EPFgFmEawCQr9WFML",
    "2R87vuaaRZRxPLdvdMEpo7fH9qyyNnP34h4nyxuwq8sKkQ1GaE",
    "7YQA3Q7fdaiMR2ZWPnHDmDbBKUypdursRUSvPM1K3WisJ5vHk",
    "2CPbpgAnKS28mVcV8YR4XrQmhjmdijwsoEQNvLbk3zK8MzT8XT",
    "TT2vQnjSF9VZfjaA5dB1VNKVdqkVCDzSncxaMcGVwYedGaMG3",
    "JuQ6MoqssBjhm7WToMCC7fod4Xsti7aXgZAEVtkTySfHm1WFY",
    "UyegvLmBWf9yw2ZRUM7jGmmjaPi8jgXdcKkRGsWkWLbvw7TNR",
    "YDJ1r9RMkewATmA7B35q1bdV18aywzmdiXwd9zGBq3uQjsCnn",
    "2r6wHLimtujzuZ1RgECVwptD9W4hyDHRsyMC71q4SxGMwJTdrH",
    "2DnTLFrwyrvDDdWWzXBZqnNZXsHbLDGBU2kkrenaF5M5xFgbDY",
    "2mrBPb5mw6rJ8aQ8k7fAHNEzVhnbdQYJbLweMtfbX5KdR38puR",
    "23aQU1537YseCJmXW11XHjPra6bptBSps5D4xXupt8hN2QUeaG",
    "4omUsdQJJYSWttfotfvbYfdyYE5CoutPpLeGUZQMcHkocZNHS",
    "2KsEUM9REjqmoydbgvug2u72wzWk838n5nwr7dqatmizGCr59n",
    "nHwhxvjAaFuaJYdQEUEqq5qhi3RgoK5cA8Yg5LM7dctrhkWT9",
    "2ABHEdVE8fEGtfyuENGoZT9csh1PWzpKZ4Fndakkrv9EdP8k6d",
    "2KiqNVP9FX1sWzhH3AEsry5J2E7vgprVVvoq2zGvUXWGEZiUR7",
    "2Tji3gHkSkkjdwiQH9Fbro3L6pxPHFdDRkCik61xwxmXgoiXq2",
    "2CPo7EiYEuJm496eJ7VgPDT2nx1n6rDpTeYcXTJvAw2W58dhpW",
    "EYf1ZdGpYgDGhe2YXRx3zM19RHk35KUwQoCfcZhAgzBbWauTU",
    "8gmZ7TNFkR8xKxqDjaWfBV6miaf3weNLcS4j7dESrPXsADb52",
    "LnJZZPwVRzv37Bp5LANU27EVhNv2hY6gN4aqm7Tx8eRpt9jhc",
    "25GzxLMKTkwibhNzcxbcmUPKZY5YEtqDc5Y19tCTAq4HbvC5Xf",
    "2L9oVyCkyqMgrwVS7CFkn21KSNWeD67dH6uzjw3LF6ErDhzAjK",
    "2nDYKNMewkSV3GvsAXfNDrRn1FVfjdjxRNrh26xDpXUrrYoobm",
    "2dviHqqxts4Sb8NBTcLAaGx1aF88pJJUEffeg2iBWZYnG6tjtJ",
    "2h3HcaMDXHv2N8WLGEQVgds93iFgd2sDPvrdKG5LVaN8HBaQfo",
    "25baXcGvNQe5DhTHej9xjTiuzFTvnjaky641Qi8csASpuPqphu",
    "pyj2Xcx5KnJFijy7PELL2SLN7pGtqV567aJZw9FYiyX22BM2Y",
    "2rw7g2nS2xBFuazsvmuLBj8LLx6RH9nGYNnfv5J1JNBP3cgeyY",
    "2EDqG1P1MSvtaXUmdQSA9oSMqJWtWVhWFmo45nhdcsxEfQcrHV",
    "uxT4KgmtktYoK8W7nRgXUqkMmh4RJEtkYzB7wS3RzLYyZoDEr",
    "22LLLpHeVi3URr3ufXDfWDLBSe7bQUjGpo2AapBCXC2BuenoVF",
    "2NnFCz82jwABA4uAKvqS3veVfPWvHy1vWDLwhVuN5fmqsT4aEB",
    "2T8Ne9HhXr8DUPyDe1NbeRiUF7TBrm74k2us9HKE3P48HjDz68",
    "k1qiJBrivmZA1QrcN2PFUzRNNa1WtxSiBzqwtEqMJ6JfMCVwG",
    "2oQjdvapawYd41bwfvY6KELPGgrXK987dSTjVmyY1R7zmXSka1",
    "2FUHgWJcZ4j8FrEi1DsdGyq6vMWQXeQGbZLuzcU6sFAazvnrYd",
    "2HR9yTVXBwxJjmejn9yt1UQnrBpQVQRpxUQe6YUtEaWh9yqnPN",
    "2GRw9HYnCxyVsr4P5pytpqcyRaymtnTuu1oZhuSWcP4DfJxojy",
    "23YwvXVh5LvSX32iMsLWRMYGCNoDLDrZye16i1KQQWZZFb3QzK",
    "txbozTNfyRgJJxtHmsbpvwTTWTHU739z7pX7qKdhJVxHC2MAk",
    "2GiVhBPR19ZaHYQivmheYv8RkEBjfdu7AyDvSocbWWjR4gz1qf",
    "2Ec9g5vbwwoy7MEyjmjjEjuS6FzaeToBm1KVbvDU6HeKsSNVTF",
    "HUwWdyoExrb1HgVp5X5sh3AWqhYFnKkfXBfGmGL3qjDsnMoR4",
    "EJ4DyXHe4ydhsLLMiDPsHtoq5RDqgyao6Lwb9znKhs59q4NQx",
    "UhReZTXT8Cqsjat9ghRtCe5kBQPQexQB5zG5Fvf3egrdYfyoJ",
    "hR6djBP7uMGJnXrjdUic2rzvvuuMpqMWNb5us7j8xgmj6Ck2N",
    "vFHT9J4F6PhqCTMmqkKKUKW3yfsjd6tNvhmcK4MkFa3Pmnnqe",
    "22CN6x5LAPEkvLDdz4UwG3XXtZV69Su3bcspiYtkF9k5f9rcCt",
    "25friWasfe2pMdVHQAh5inDBz5XQq42a1V8DYqAGnxeKks5Bkp",
    "2vEit8MMxLNNfbMdoiBjvFP7MFwPwo1YmiLaBBxQU2YRGvdjJx",
    "2Xj6iZeySuuUTZR5jYjhQ7yQ84q8AtDWnAJ2vS9BmmXBNJhYD1",
    "27xa71ERzSzir2KuPmmsAFkceVA74Xfh8Fys8SrmHjdKyj1vqd",
    "2QGraMRcH8gEnQbLviM4ykgyY31jFfLhaEtEvPHk8q8pPfe7Kj",
    "2cJ7FyNoqigEGoM7m8p4PY7a33B2SQxV8P7VuUVJZ9y5otyqNS",
    "Lgiwfx9L11MLt8RD5Aj7SZ5kEcWQz5NnyCc5hDd5k25J8LoxM",
    "2tmrrBo1Lgt1mzzvPSFt73kkQKFas5d1AP88tv9cicwoFp8BSn",
    "2Zqzt687kQ4G7RiWYKypiWrid4ZPrFW3jg9Hy5SmNAVgebB2ph",
    "2PKgDmUGYJEV3gSBkvM7ztJuSk3g7omGjDjHdQR28Tv8JSxFBK",
    "k2SFEZ2MZr9UGXiycnA1DdaLqZTKDaHK7WUXVLhJk5F9DD8r1",
    "HnECQEqpvvXcBF9Jup1ti1XMowQGrSWiQSkKdwcjxEbzmTHMC",
    "2tsFdSeemtqK9vaPgjPrcwvKFKPw1T6PHufaZ26tKbAFSkXPTE",
    "2tdRBvNEUhoD6ZWYF9b5NBdj5hHwWPfvSq1EnzvV8QU2XjLNy9",
    "22v7AG7h6qaVxd4bLvAsSsg2LZ4RCn5iVYgFn7a2Fj1LCuYwjv",
    "222KARi6VgSZXbewFp1BvZgyuSKVa9JPb7swhbwN9fUHFKgxUD",
    "m4xWma3wWpxHAAKWyDXX6oqvzKUkqCXnTJTwKmTkReJpcEuS6",
    "QVbrD172sAF1TgCvN9DZG93nAd2YBGCJVZP4cngdEKCTy2F9v",
    "2PDRxzc6jMbZSTLb3sufkVszgQc2jtDnYZGtDTAAfom1CTwPsE",
    "2MrmXmx4nrSn5BS3EAtWg5Pf9madiBoN7MRaByM88g49VArjDt",
    "21Ths5Afqi5r4PaoV8r8cruGZWhN11y5rxvy89K8px7pKy3P8E",
    "2jRZvKtXY5nyWTqRwFh1KMHGrCRxJoULu4r2CsayWRnjdDGbV1",
    "q2aTwKuyzgs8pynF7UXBZCU7DejbZbZ6EUyHr3JQzYgwNPUPi",
    "2oYMBNV4eNHyqk2fjjV5nVQLDbtmNJzq5s3qs3Lo6ftnC6FByM",
    "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5",
].slice(0, 15)
