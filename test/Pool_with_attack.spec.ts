import {ethers, waffle} from 'hardhat';
import {expect} from 'chai';
import {BigNumber, BigNumber as BN, Wallet} from 'ethers';
import chai from 'chai';
const {solidity, loadFixture} = waffle;
chai.use(solidity);

import {MockFactory, MockPool, MockToken, MockToken__factory, MockPool__factory} from '../typechain';
import {QuoterV2, QuoterV2__factory, MockCallbacks, MockCallbacks__factory, MockPoolOracle} from '../typechain';

import {MIN_LIQUIDITY, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO, FEE_UNITS} from './helpers/helper';
import {ZERO_ADDRESS, ZERO, ONE, MAX_UINT, PRECISION, TWO, BPS, NEGATIVE_ONE} from './helpers/helper';
import {deployMockFactory, getTicksPrevious} from './helpers/setup';
import {genRandomBN} from './helpers/genRandomBN';
import {logBalanceChange, logSwapState, SwapTitle} from './helpers/logger';
import {encodePriceSqrt, getMaxTick, getMinTick, getNearestSpacedTickAtPrice} from './helpers/utils';
import {getPriceFromTick, snapshotGasCost} from './helpers/utils';

let factory: MockFactory;
let poolOracle: MockPoolOracle;
let token0: MockToken;
let token1: MockToken;
let quoter: QuoterV2;
let poolBalToken0: BN;
let poolBalToken1: BN;
let poolArray: MockPool[] = [];
let pool: MockPool;
let callback: MockCallbacks;
let swapFeeUnitsArray = [50];
let swapFeeUnits = swapFeeUnitsArray[0];
let tickDistanceArray = [1];
let tickDistance = tickDistanceArray[0];
let vestingPeriod = 100;

let minTick = getMinTick(tickDistance);
let maxTick = getMaxTick(tickDistance);
let ticksPrevious: [BN, BN] = [MIN_TICK, MIN_TICK];
let initialPrice: BN;
let nearestTickToPrice: number; // the floor of tick that mod tickDistance = 0
let tickLower: number;
let tickUpper: number;
let tickLowerData: any;
let tickUpperData: any;
let positionData: any;

class Fixtures {
  constructor(
    public factory: MockFactory,
    public poolOracle: MockPoolOracle,
    public poolArray: MockPool[],
    public token0: MockToken,
    public token1: MockToken,
    public callback: MockCallbacks,
    public quoter: QuoterV2
  ) {}
}

describe('Pool_with_attack', () => {
  const [user, admin, configMaster] = waffle.provider.getWallets();

  async function fixture(): Promise<Fixtures> {
    let [factory, poolOracle] = await deployMockFactory(admin, vestingPeriod);
    const PoolContract = (await ethers.getContractFactory('MockPool')) as MockPool__factory;
    // add any newly defined tickDistance apart from default ones
    for (let i = 0; i < swapFeeUnitsArray.length; i++) {
      if ((await factory.feeAmountTickDistance(swapFeeUnitsArray[i])) == 0) {
      await factory.connect(admin).enableSwapFee(swapFeeUnitsArray[i], tickDistanceArray[i]);
      }
    }

    const MockTokenContract = (await ethers.getContractFactory('MockToken')) as MockToken__factory;
    const tokenA = await MockTokenContract.deploy('USDC', 'USDC', PRECISION.mul(PRECISION));
    const tokenB = await MockTokenContract.deploy('DAI', 'DAI', PRECISION.mul(PRECISION));
    token0 = tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? tokenA : tokenB;
    token1 = token0.address == tokenA.address ? tokenB : tokenA;

    // create pools
    let poolArray = [];
    for (let i = 0; i < swapFeeUnitsArray.length; i++) {
      await factory.createPool(token0.address, token1.address, swapFeeUnitsArray[i]);
      const poolAddress = await factory.getPool(token0.address, token1.address, swapFeeUnitsArray[i]);
      poolArray.push(PoolContract.attach(poolAddress));
      console.log("poolAddress:", poolAddress);
    }

    const CallbackContract = (await ethers.getContractFactory('MockCallbacks')) as MockCallbacks__factory;
    let callback = await CallbackContract.deploy(tokenA.address, tokenB.address);
    // user give token approval to callbacks
    await tokenA.connect(user).approve(callback.address, MAX_UINT);
    await tokenB.connect(user).approve(callback.address, MAX_UINT);

    const QuoterV2Contract = (await ethers.getContractFactory('QuoterV2')) as QuoterV2__factory;
    let quoter = await QuoterV2Contract.deploy(factory.address);

    return new Fixtures(factory, poolOracle, poolArray, token0, token1, callback, quoter);
  }

  beforeEach('load fixture', async () => {
    ({factory, poolOracle, poolArray, token0, token1, callback, quoter} = await loadFixture(fixture));
    pool = poolArray[0];
  });


  describe('USD108M_test', async () => {
    beforeEach('unlock pool with initial price of 1:2', async () => {
      initialPrice = encodePriceSqrt(ONE, TWO);
      await callback.unlockPool(pool.address, initialPrice);
      // whitelist callback for minting position
      await factory.connect(admin).addNFTManager(callback.address);
      nearestTickToPrice = (await getNearestSpacedTickAtPrice(initialPrice, tickDistance)).toNumber();

      console.log("Position 1:")
      console.log("TickLower",nearestTickToPrice - 2 * tickDistance);
      console.log("TickUpper",nearestTickToPrice + 2 * tickDistance);
      console.log("Position 2:")
      console.log("TickLower",nearestTickToPrice - 1 * tickDistance);
      console.log("TickUpper",nearestTickToPrice + 1 * tickDistance);
      await callback.mint(
        pool.address,
        user.address,
        nearestTickToPrice -  tickDistance-1,
        nearestTickToPrice +  tickDistance+1,
        ticksPrevious,
        PRECISION.mul(100),
        '0x'
      );
      await callback.mint(
        pool.address,
        user.address,
        nearestTickToPrice - tickDistance,
        nearestTickToPrice + tickDistance,
        ticksPrevious,
        PRECISION.mul(100),
        '0x'
      );
    });

    it('3 swaps: should same current tick and nearestCurrentTick', async () => {
      await logSwapState(SwapTitle.BEFORE_SWAP, pool);
      console.log(">>>>>>>>>>>>SwapToDownTick: <<<<<<<<<<<<",nearestTickToPrice - 1 * tickDistance)
      console.log(await getPriceFromTick(nearestTickToPrice - tickDistance));
      await callback.swap(pool.address, user.address, PRECISION, true, await getPriceFromTick(nearestTickToPrice - tickDistance), '0x')
      await logSwapState(SwapTitle.AFTER_SWAP, pool);
      console.log(">>>>>>>>>>>>SwapForward: <<<<<<<<<<<<");
      await callback.swap(pool.address, user.address, ONE*1, false, await getPriceFromTick(nearestTickToPrice ), '0x')
      await logSwapState(SwapTitle.AFTER_SWAP, pool);
      console.log(">>>>>>>>>>>>Swap backwards again: <<<<<<<<<<<<");
      await callback.swap(pool.address, user.address, ONE*2, true, await getPriceFromTick(nearestTickToPrice - 2*tickDistance), '0x')
      await logSwapState(SwapTitle.AFTER_SWAP, pool);
      expect((await pool.getPoolState()).currentTick).to.be.eq((await pool.getPoolState()).nearestCurrentTick);
    });

    it('1 swap: should same current tick and nearestCurrentTick', async () => {
      await logSwapState(SwapTitle.BEFORE_SWAP, pool);
      console.log(">>>>>>>>>>>>SwapToDownTick +ONE: <<<<<<<<<<<<",nearestTickToPrice - 1 * tickDistance)
      console.log(await getPriceFromTick(nearestTickToPrice - tickDistance));
      let swapQty=BN.from("16714560451463654")
      await callback.swap(pool.address, user.address, swapQty.add(ONE), true, await getPriceFromTick(nearestTickToPrice - 2*tickDistance), '0x');
      //let userBalBefore = await token0.balanceOf(user.address);
      //await callback.swap(pool.address, user.address, PRECISION, true, await getPriceFromTick(nearestTickToPrice - 1*tickDistance), '0x');
      //let userBalafter = await token0.balanceOf(user.address);
      //let swapQty = userBalafter.sub(userBalBefore);
      //console.log(swapQty.toString());
      await logSwapState(SwapTitle.AFTER_SWAP, pool);
      expect((await pool.getPoolState()).currentTick).to.be.eq((await pool.getPoolState()).nearestCurrentTick);
    });
  });
});

async function isTickCleared(tick: number): Promise<boolean> {
  const {liquidityGross, feeGrowthOutside, liquidityNet} = await pool.ticks(tick);
  if (!feeGrowthOutside.eq(ZERO)) return false;
  if (!liquidityNet.eq(ZERO)) return false;
  if (!liquidityGross.eq(ZERO)) return false;
  return true;
}

async function doRandomSwaps(pool: MockPool, user: Wallet, iterations: number, maxSwapQty?: BN) {
  for (let i = 0; i < iterations; i++) {
    let isToken0 = Math.random() < 0.5;
    let isExactInput = Math.random() < 0.5;
    const maxRange = maxSwapQty ? maxSwapQty : PRECISION.mul(BPS);
    let swapQty = genRandomBN(maxRange.div(2), maxRange);
    if (!isExactInput) {
      let token = isToken0 ? token0 : token1;
      let poolBal = await token.balanceOf(pool.address);
      if (swapQty.gt(poolBal)) swapQty = genRandomBN(ONE, poolBal);
      swapQty = swapQty.mul(-1);
    }
    let priceLimit;
    // willUpTick = exactInputToken1 or exactOutputToken0
    if ((isExactInput && !isToken0) || (!isExactInput && isToken0)) {
      priceLimit = MAX_SQRT_RATIO.sub(ONE);
    } else {
      priceLimit = MIN_SQRT_RATIO.add(ONE);
    }
    // console.log(`swapping ${swapQty.toString()}`);
    // console.log(`isToken0=${isToken0} isExactInput=${isExactInput}`);
    await callback.connect(user).swap(pool.address, user.address, swapQty, isToken0, priceLimit, '0x');
    // advance time between each swap
    await pool.forwardTime(3);
  }
}

async function swapToUpTick(pool: MockPool, user: Wallet, targetTick: number, maxSwapQty?: BN) {
  while ((await pool.getPoolState()).currentTick < targetTick) {
    // either specify exactInputToken1 or exactOutputToken0
    let isToken0 = Math.random() < 0.5;
    let isExactInput = !isToken0;
    const maxRange = maxSwapQty ? maxSwapQty : PRECISION.mul(BPS);
    let swapQty = genRandomBN(maxRange.div(2), maxRange);
    if (!isExactInput) {
      let token = isToken0 ? token0 : token1;
      let poolBal = await token.balanceOf(pool.address);
      if (swapQty.gt(poolBal)) swapQty = genRandomBN(ONE, poolBal);
      swapQty = swapQty.mul(-1);
    }
    await callback
      .connect(user)
      .swap(pool.address, user.address, swapQty, isToken0, await getPriceFromTick(targetTick), '0x');
    // advance time between each swap
    await pool.forwardTime(3);
  }
}

async function swapToDownTick(pool: MockPool, user: Wallet, targetTick: number, maxSwapQty?: BN) {
  let realSwapQty=ZERO;
  while ((await pool.getPoolState()).currentTick > targetTick) {
    // either specify exactInputToken0 or exactOutputToken1
    let isToken0 = Math.random() < 0.5;
    let isExactInput = isToken0;
    const maxRange = maxSwapQty ? maxSwapQty : PRECISION.mul(BPS);
    let swapQty = genRandomBN(maxRange.div(2), maxRange);
    if (!isExactInput) {
      let token = isToken0 ? token0 : token1;
      let poolBal = await token.balanceOf(pool.address);
      if (swapQty.gt(poolBal)) swapQty = genRandomBN(ONE, poolBal);
      swapQty = swapQty.mul(-1);
    }else{
      realSwapQty=realSwapQty.add(swapQty)
    }

    await callback
      .connect(user)
      .swap(pool.address, user.address, swapQty, isToken0, await getPriceFromTick(targetTick), '0x');
    // advance time between each swap
    await pool.forwardTime(3);
  }
  console.log(realSwapQty.toString())
}

async function getTimeElapsedPerLiquidity(pool: MockPool, tickLower: number, tickUpper: number) {
  let currentTick = (await pool.getPoolState()).currentTick;
  if (tickLower <= currentTick && currentTick < tickUpper) {
    let timestamp = BN.from(await pool.blockTimestamp());
    let lastUpdateTime = (await pool.getSecondsPerLiquidityData()).lastUpdateTime;
    let secondsElapsed =  timestamp.sub(lastUpdateTime);
    let baseL = (await pool.getLiquidityState()).baseL;
    if (secondsElapsed.gt(0) && baseL.gt(0)) {
      return secondsElapsed.shl(96).div(baseL);
    }
  }
  return BN.from(0);
}
