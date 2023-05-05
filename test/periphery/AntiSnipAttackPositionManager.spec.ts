import {ethers, waffle} from 'hardhat';
import {expect} from 'chai';
import {Wallet, BigNumber, ContractTransaction} from 'ethers';
import chai from 'chai';

const {solidity} = waffle;
chai.use(solidity);

import {
  MockToken,
  MockToken__factory,
  MockWeth,
  MockWeth__factory,
  AntiSnipAttackPositionManager,
  AntiSnipAttackPositionManager__factory,
  Router__factory,
  Router,
  Factory,
  Pool,
  MockTokenPositionDescriptor,
  MockTokenPositionDescriptor__factory,
  MockSnipAttack,
  MockSnipAttack__factory,
  TicksFeesReader,
  MockAntiSnipAttack,
  TicksFeesReader__factory,
  MockAntiSnipAttack__factory,
} from '../../typechain';

import {deployFactory, getTicksPrevious} from '../helpers/setup';
import {snapshot, revertToSnapshot, setNextBlockTimestampFromCurrent, getLatestBlockTime} from '../helpers/hardhat';
import {BN, PRECISION, ZERO_ADDRESS, ZERO, MIN_TICK, ONE, FEE_UNITS} from '../helpers/helper';
import {encodePriceSqrt, sortTokens, orderTokens} from '../helpers/utils';

const showTxGasUsed = true;
const BIG_AMOUNT = BN.from(2).pow(255);

let Token: MockToken__factory;
let PositionManager: AntiSnipAttackPositionManager__factory;
let factory: Factory;
let positionManager: AntiSnipAttackPositionManager;
let router: Router;
let tokenDescriptor: MockTokenPositionDescriptor;
let tokenA: MockToken;
let tokenB: MockToken;
let token0: string;
let token1: string;
let weth: MockWeth;
let nextTokenId: BigNumber;
let swapFeeUnitsArray = [50, 300];
let tickDistanceArray = [10, 60];
let ticksPrevious: [BigNumber, BigNumber] = [MIN_TICK, MIN_TICK];
let vestingPeriod = 1000;
let initialPrice: BigNumber;
let snapshotId: any;
let initialSnapshotId: any;

describe('AntiSnipAttackPositionManager', () => {
  const [user, admin, other] = waffle.provider.getWallets();
  const tickLower = -100 * tickDistanceArray[0];
  const tickUpper = 100 * tickDistanceArray[0];

  before('factory, token and callback setup', async () => {
    Token = (await ethers.getContractFactory('MockToken')) as MockToken__factory;
    tokenA = await Token.deploy('USDC', 'USDC', BN.from(100000000000).mul(PRECISION));
    tokenB = await Token.deploy('DAI', 'DAI', BN.from(100000000000).mul(PRECISION));
    [tokenA, tokenB] = orderTokens(tokenA, tokenB);
    factory = await deployFactory(admin, vestingPeriod);

    const WETH = (await ethers.getContractFactory('MockWeth')) as MockWeth__factory;
    weth = await WETH.deploy();

    const Descriptor = (await ethers.getContractFactory(
      'MockTokenPositionDescriptor'
    )) as MockTokenPositionDescriptor__factory;
    tokenDescriptor = await Descriptor.deploy();

    PositionManager = (await ethers.getContractFactory(
      'AntiSnipAttackPositionManager'
    )) as AntiSnipAttackPositionManager__factory;
    positionManager = await PositionManager.deploy(factory.address, weth.address, tokenDescriptor.address);
    await factory.connect(admin).addNFTManager(positionManager.address);

    const Router = (await ethers.getContractFactory('Router')) as Router__factory;
    router = await Router.deploy(factory.address, weth.address);

    // add any newly defined tickDistance apart from default ones
    for (let i = 0; i < swapFeeUnitsArray.length; i++) {
      if ((await factory.feeAmountTickDistance(swapFeeUnitsArray[i])) == 0) {
        await factory.connect(admin).enableSwapFee(swapFeeUnitsArray[i], tickDistanceArray[i]);
      }
    }

    initialPrice = encodePriceSqrt(1, 1);

    await weth.connect(user).deposit({value: PRECISION.mul(10)});
    await weth.connect(other).deposit({value: PRECISION.mul(10)});

    await weth.connect(user).approve(positionManager.address, BIG_AMOUNT);
    await tokenA.connect(user).approve(positionManager.address, BIG_AMOUNT);
    await tokenB.connect(user).approve(positionManager.address, BIG_AMOUNT);
    await weth.connect(other).approve(positionManager.address, BIG_AMOUNT);
    await tokenA.connect(other).approve(positionManager.address, BIG_AMOUNT);
    await tokenB.connect(other).approve(positionManager.address, BIG_AMOUNT);

    await weth.connect(user).approve(router.address, BIG_AMOUNT);
    await tokenA.connect(user).approve(router.address, BIG_AMOUNT);
    await tokenB.connect(user).approve(router.address, BIG_AMOUNT);
    await weth.connect(other).approve(router.address, BIG_AMOUNT);
    await tokenA.connect(other).approve(router.address, BIG_AMOUNT);
    await tokenB.connect(other).approve(router.address, BIG_AMOUNT);

    await tokenA.transfer(user.address, PRECISION.mul(2000000));
    await tokenB.transfer(user.address, PRECISION.mul(2000000));
    await tokenA.transfer(other.address, PRECISION.mul(2000000));
    await tokenB.transfer(other.address, PRECISION.mul(2000000));

    [token0, token1] = sortTokens(tokenA.address, tokenB.address);

    getBalances = async (account: string, tokens: string[]) => {
      let balances = [];
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] == ZERO_ADDRESS) {
          balances.push(await ethers.provider.getBalance(account));
        } else {
          balances.push(await (await Token.attach(tokens[i])).balanceOf(account));
        }
      }
      return {
        tokenBalances: balances,
      };
    };

    initialSnapshotId = await snapshot();
    snapshotId = initialSnapshotId;
  });

  const createAndUnlockPools = async () => {
    let initialPrice = encodePriceSqrt(1, 1);
    let [token0, token1] = sortTokens(tokenA.address, tokenB.address);
    await positionManager
      .connect(user)
      .createAndUnlockPoolIfNecessary(token0, token1, swapFeeUnitsArray[0], initialPrice);
    [token0, token1] = sortTokens(tokenA.address, weth.address);
    await positionManager
      .connect(user)
      .createAndUnlockPoolIfNecessary(token0, token1, swapFeeUnitsArray[0], initialPrice);
    [token0, token1] = sortTokens(tokenB.address, weth.address);
    await positionManager
      .connect(user)
      .createAndUnlockPoolIfNecessary(token0, token1, swapFeeUnitsArray[0], initialPrice);
  };

  let getBalances: (
    who: string,
    tokens: string[]
  ) => Promise<{
    tokenBalances: BigNumber[];
  }>;

  describe(`#mint`, async () => {
    before('create and unlock pools', async () => {
      await revertToSnapshot(initialSnapshotId);
      initialSnapshotId = await snapshot();
      await createAndUnlockPools();
      snapshotId = await snapshot();
    });

    beforeEach('revert to snapshot', async () => {
      await revertToSnapshot(snapshotId);
      snapshotId = await snapshot();
      nextTokenId = await positionManager.nextTokenId();
    });

    it('should initialize antiSnipAttackData for the minted position', async () => {
      let _nextTokenId = nextTokenId;
      await positionManager.connect(user).mint({
        token0: token0,
        token1: token1,
        fee: swapFeeUnitsArray[0],
        tickLower: tickLower,
        tickUpper: tickUpper,
        ticksPrevious: ticksPrevious,
        amount0Desired: BN.from(1000000),
        amount1Desired: BN.from(1000000),
        amount0Min: 0,
        amount1Min: 0,
        recipient: user.address,
        deadline: PRECISION,
      });

      let antiSnipAttackData = await positionManager.antiSnipAttackData(_nextTokenId);
      expect(antiSnipAttackData.lastActionTime).to.be.gt(ZERO);
      expect(antiSnipAttackData.lockTime).to.be.gt(ZERO);
      expect(antiSnipAttackData.unlockTime).to.be.gt(ZERO);
      expect(antiSnipAttackData.feesLocked).to.be.eq(ZERO);
    });

    it('revert expired', async () => {
      let [token0, token1] = sortTokens(tokenA.address, tokenB.address);
      await expect(
        positionManager.connect(user).mint({
          token0: token0,
          token1: token1,
          fee: swapFeeUnitsArray[0],
          tickLower: 0,
          tickUpper: 0,
          ticksPrevious: ticksPrevious,
          amount0Desired: 0,
          amount1Desired: 0,
          amount0Min: 0,
          amount1Min: 0,
          recipient: user.address,
          deadline: 0,
        })
      ).to.be.revertedWith('Expired');
    });
  });

  const mintPosition = async (
    user: Wallet, token0: string, token1: string, swapFee: number,
    ticks: [number, number], ticksPrevious: [BigNumber, BigNumber],
    amount = 1000000
  ) => {
    await positionManager.connect(user).mint({
      token0: token0,
      token1: token1,
      fee: swapFee,
      tickLower: ticks[0],
      tickUpper: ticks[1],
      ticksPrevious: ticksPrevious,
      amount0Desired: BN.from(amount),
      amount1Desired: BN.from(amount),
      amount0Min: 1,
      amount1Min: 1,
      recipient: user.address,
      deadline: PRECISION,
    });
  }

  const initLiquidity = async (user: Wallet, token0: string, token1: string, amount = 1000000) => {
    [token0, token1] = sortTokens(token0, token1);
    await mintPosition(
      user, token0, token1, swapFeeUnitsArray[0],
      [-100 * tickDistanceArray[0], 100 * tickDistanceArray[0]],
      ticksPrevious, amount
    );
  };

  const swapExactInput = async function (tokenIn: string, tokenOut: string, poolFee: number, amount: BigNumber) {
    const swapParams = {
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      fee: poolFee,
      recipient: user.address,
      deadline: BN.from(2).pow(255),
      amountIn: amount,
      minAmountOut: BN.from(0),
      limitSqrtP: BN.from(0),
    };
    await router.connect(user).swapExactInputSingle(swapParams);
  };

  const removeLiquidity = async function (
    tokenIn: string,
    tokenOut: string,
    user: Wallet,
    tokenId: BigNumber,
    liquidity: BigNumber
  ): Promise<ContractTransaction> {
    let removeLiquidityParams = {
      tokenId: tokenId,
      liquidity: liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline: PRECISION,
    };
    // need to use multicall to collect tokens
    let multicallData = [positionManager.interface.encodeFunctionData('removeLiquidity', [removeLiquidityParams])];
    multicallData.push(positionManager.interface.encodeFunctionData('transferAllTokens', [tokenIn, 0, user.address]));
    multicallData.push(positionManager.interface.encodeFunctionData('transferAllTokens', [tokenOut, 0, user.address]));
    let tx = await positionManager.connect(user).multicall(multicallData);
    return tx;
  };

  const syncFeeGrowth = async function (user: Wallet, tokenId: BigNumber): Promise<ContractTransaction> {
    let tx = await positionManager.connect(user).syncFeeGrowth(tokenId);
    return tx;
  };

  const burnRTokens = async function (
    tokenIn: string,
    tokenOut: string,
    user: Wallet,
    tokenId: BigNumber
  ): Promise<ContractTransaction> {
    // call to burn rTokens
    let burnRTokenParams = {
      tokenId: tokenId,
      amount0Min: 1,
      amount1Min: 1,
      deadline: PRECISION,
    };
    let multicallData = [positionManager.interface.encodeFunctionData('burnRTokens', [burnRTokenParams])];
    multicallData.push(positionManager.interface.encodeFunctionData('transferAllTokens', [tokenIn, 0, user.address]));
    multicallData.push(positionManager.interface.encodeFunctionData('transferAllTokens', [tokenOut, 0, user.address]));
    let tx = await positionManager.connect(user).multicall(multicallData);
    return tx;
  };

  describe(`#add liquidity`, async () => {
    before('create and unlock pools', async () => {
      await revertToSnapshot(initialSnapshotId);
      initialSnapshotId = await snapshot();
      await createAndUnlockPools();
      snapshotId = await snapshot();
    });

    beforeEach('revert to snapshot', async () => {
      await revertToSnapshot(snapshotId);
      snapshotId = await snapshot();
      nextTokenId = await positionManager.nextTokenId();
    });

    it('no change to rTokenOwed and feeGrowthInsideLast when adding liquidity with tokens - no new fees', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address);

      let gasUsed = ZERO;
      let numRuns = 3;

      for (let i = 0; i < numRuns; i++) {
        let amount0 = BN.from(100000 * (i + 1));
        let amount1 = BN.from(120000 * (i + 1));
        let tokenId = nextTokenId;

        let userData = await positionManager.positions(tokenId);
        let tx;
        await expect(
          (tx = await positionManager.connect(user).addLiquidity({
            tokenId: tokenId,
            ticksPrevious: [0, 0],
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0,
            amount1Min: 0,
            deadline: PRECISION,
          }))
        ).to.be.emit(positionManager, 'AddLiquidity');

        gasUsed = gasUsed.add((await tx.wait()).gasUsed);

        // should earn no fee as no swap
        let userNewData = await positionManager.positions(tokenId);
        expect(userNewData.pos.rTokenOwed).to.be.eq(userData.pos.rTokenOwed);
        expect(userNewData.pos.feeGrowthInsideLast).to.be.eq(userData.pos.feeGrowthInsideLast); // should update to latest fee growth
      }
      if (showTxGasUsed) {
        logMessage(`Average gas use for add liquidity - no new fees: ${gasUsed.div(numRuns).toString()}`);
      }
    });

    it('change to rTokenOwed and feeGrowthInsideLast when adding liquidity with tokens - has new fees', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address);

      let gasUsed = ZERO;
      let numRuns = 3;

      for (let i = 0; i < numRuns; i++) {
        let amount0 = BN.from(100000 * (i + 1));
        let amount1 = BN.from(120000 * (i + 1));

        let userData = await positionManager.positions(nextTokenId);

        // made some swaps to get fees
        for (let j = 0; j < 5; j++) {
          let amount = BN.from(100000 * (j + 1));
          await swapExactInput(tokenA.address, tokenB.address, swapFeeUnitsArray[0], amount);
          amount = BN.from(150000 * (j + 1));
          await swapExactInput(tokenB.address, tokenA.address, swapFeeUnitsArray[0], amount);
        }

        let tx;
        await expect(
          (tx = await positionManager.connect(user).addLiquidity({
            tokenId: nextTokenId,
            ticksPrevious: [0, 0],
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0,
            amount1Min: 0,
            deadline: PRECISION,
          }))
        ).to.be.emit(positionManager, 'AddLiquidity');

        gasUsed = gasUsed.add((await tx.wait()).gasUsed);

        // should update rToken owed and latest fee growth
        let userNewData = await positionManager.positions(nextTokenId);
        expect(userNewData.pos.rTokenOwed).to.not.be.eq(userData.pos.rTokenOwed);
        // feeGrowthInsideLast should have changed
        expect(userNewData.pos.feeGrowthInsideLast).to.not.be.eq(userData.pos.feeGrowthInsideLast);
      }
      if (showTxGasUsed) {
        logMessage(`Average gas use for add liquidity - has new fees: ${gasUsed.div(numRuns).toString()}`);
      }
    });

    it('add liquidity to a closed position', async () => {
      // add 2 positions with the same ticks
      await mintPosition(
        user, tokenA.address, tokenB.address, swapFeeUnitsArray[0],
        [-100 * tickDistanceArray[0], 100 * tickDistanceArray[0]],
        ticksPrevious, 100000
      );
      await mintPosition(
        other, tokenA.address, tokenB.address, swapFeeUnitsArray[0],
        [-100 * tickDistanceArray[0], 100 * tickDistanceArray[0]],
        ticksPrevious, 100000
      );
      // ### Remove all liquidity and re-add, ticks are not de-initialized
      let position0 = await positionManager.positions(nextTokenId);
      await positionManager.connect(user).removeLiquidity({
        tokenId: nextTokenId, liquidity: position0[0].liquidity, amount0Min: 1, amount1Min: 1, deadline: PRECISION,
      });
      position0 = await positionManager.positions(nextTokenId);
      expect(position0[0].liquidity).to.be.eq(0);
      // verify ticks are not de-initialized
      let poolAddress = await factory.getPool(tokenA.address, tokenB.address, swapFeeUnitsArray[0]);
      let pool = (await ethers.getContractAt('Pool', poolAddress)) as Pool;
      let tickData = await pool.initializedTicks(position0[0].tickLower);
      expect(tickData[0]).to.be.not.eq(tickData[1]);
      tickData = await pool.initializedTicks(position0[0].tickUpper);
      expect(tickData[0]).to.be.not.eq(tickData[1]);
      // add liquidity again to the closed position
      await positionManager.connect(user).addLiquidity({
        tokenId: nextTokenId,
        ticksPrevious: [0, 0],
        amount0Desired: 200000,
        amount1Desired: 200000,
        amount0Min: 1,
        amount1Min: 1,
        deadline: PRECISION,
      });
      position0 = await positionManager.positions(nextTokenId);
      expect(position0[0].liquidity).to.be.not.eq(0);
    });

    it('add liquidity to a closed position, both ticks are de-initialized', async () => {
      // add 2 positions with the same ticks
      await mintPosition(
        user, tokenA.address, tokenB.address, swapFeeUnitsArray[0],
        [-100 * tickDistanceArray[0], 100 * tickDistanceArray[0]],
        ticksPrevious, 100000
      );
      await mintPosition(
        other, tokenA.address, tokenB.address, swapFeeUnitsArray[0],
        [-200 * tickDistanceArray[0], 200 * tickDistanceArray[0]],
        ticksPrevious, 100000
      );
      // remove all liquidity from the first position, upper tick is de-initialized
      let position0 = await positionManager.positions(nextTokenId);
      await positionManager.connect(user).removeLiquidity({
        tokenId: nextTokenId, liquidity: position0[0].liquidity, amount0Min: 1, amount1Min: 1, deadline: PRECISION,
      });
      position0 = await positionManager.positions(nextTokenId);
      expect(position0[0].liquidity).to.be.eq(0);
      // verify lower tick is de-initialized
      let poolAddress = await factory.getPool(tokenA.address, tokenB.address, swapFeeUnitsArray[0]);
      let pool = (await ethers.getContractAt('Pool', poolAddress)) as Pool;
      let tickData = await pool.initializedTicks(position0[0].tickLower);
      expect(tickData[0]).to.be.eq(tickData[1]);
      tickData = await pool.initializedTicks(position0[0].tickUpper);
      expect(tickData[0]).to.be.eq(tickData[1]);
      // add liquidity again to the closed position, it should be reverted as tick previous is not initialized
      await expect(positionManager.connect(user).addLiquidity({
        tokenId: nextTokenId,
        ticksPrevious: [position0[0].tickLower, position0[0].tickUpper],
        amount0Desired: 200000,
        amount1Desired: 200000,
        amount0Min: 1,
        amount1Min: 1,
        deadline: PRECISION,
      })).to.be.revertedWith('previous tick has been removed');
      position0 = await positionManager.positions(0);
      expect(position0[0].liquidity).to.be.eq(0);
      // add liquidity again with correct initialized tick previous
      let _ticksPrevious = await getTicksPrevious(pool, position0[0].tickLower, position0[0].tickUpper);
      await positionManager.connect(user).addLiquidity({
        tokenId: nextTokenId,
        ticksPrevious: _ticksPrevious,
        amount0Desired: 200000,
        amount1Desired: 200000,
        amount0Min: 1,
        amount1Min: 1,
        deadline: PRECISION,
      });
      position0 = await positionManager.positions(nextTokenId);
      expect(position0[0].liquidity).to.be.not.eq(0);
      tickData = await pool.initializedTicks(position0[0].tickLower);
      expect(tickData[0]).to.be.not.eq(tickData[1]);
    });
  });

  describe(`#remove liquidity`, async () => {
    before('create and unlock pools', async () => {
      await revertToSnapshot(initialSnapshotId);
      initialSnapshotId = await snapshot();
      await createAndUnlockPools();
      snapshotId = await snapshot();
    });

    beforeEach('revert to snapshot', async () => {
      await revertToSnapshot(snapshotId);
      snapshotId = await snapshot();
      nextTokenId = await positionManager.nextTokenId();
    });

    it('revert insufficient liquidity', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address);
      let userData = await positionManager.positions(nextTokenId);
      await expect(
        positionManager.connect(user).removeLiquidity({
          tokenId: nextTokenId,
          liquidity: userData.pos.liquidity.add(ONE),
          amount0Min: 0,
          amount1Min: 0,
          deadline: PRECISION,
        })
      ).to.be.revertedWith('Insufficient liquidity');
    });

    it('revert price slippage', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address);
      await expect(
        positionManager.connect(user).removeLiquidity({
          tokenId: nextTokenId,
          liquidity: 10,
          amount0Min: PRECISION,
          amount1Min: 0,
          deadline: PRECISION,
        })
      ).to.be.revertedWith('Low return amounts');
      await expect(
        positionManager.connect(user).removeLiquidity({
          tokenId: nextTokenId,
          liquidity: 10,
          amount0Min: 0,
          amount1Min: PRECISION,
          deadline: PRECISION,
        })
      ).to.be.revertedWith('Low return amounts');
    });

    it('no change to rTokenOwed and feeGrowthInsideLast when removing liquidity with tokens - no new fees', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address);

      let gasUsed = ZERO;
      let numRuns = 3;

      for (let i = 0; i < numRuns; i++) {
        let liquidity = BN.from((i + 1) * 100);
        let userData = await positionManager.positions(nextTokenId);

        let tx = await removeLiquidity(tokenA.address, tokenB.address, user, nextTokenId, liquidity);
        gasUsed = gasUsed.add((await tx.wait()).gasUsed);

        // no change to fee growth inside and rTokensOwed
        let userNewData = await positionManager.positions(nextTokenId);
        expect(userNewData.pos.rTokenOwed).to.be.eq(userData.pos.rTokenOwed);
        expect(userNewData.pos.feeGrowthInsideLast).to.be.eq(userData.pos.feeGrowthInsideLast); // should update to latest fee growth
      }
      if (showTxGasUsed) {
        logMessage(`Average gas use for remove liquidity - no new fees: ${gasUsed.div(numRuns).toString()}`);
      }
    });

    it('should have 0 burnable tokens if liquidity removal happens after vesting period', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address);

      let gasUsed = ZERO;
      let numRuns = 3;
      let pool = await factory.getPool(token0, token1, swapFeeUnitsArray[0]);
      let poolContract = (await ethers.getContractAt('Pool', pool)) as Pool;

      for (let i = 0; i < numRuns; i++) {
        let liquidity = BN.from((i + 1) * 50);
        let userData = await positionManager.positions(nextTokenId);

        // made some swaps to get fees
        for (let j = 0; j < 5; j++) {
          let amount = BN.from(100000 * (j + 1));
          await swapExactInput(tokenA.address, tokenB.address, swapFeeUnitsArray[0], amount);
          amount = BN.from(150000 * (j + 1));
          await swapExactInput(tokenB.address, tokenA.address, swapFeeUnitsArray[0], amount);
        }

        // next block timestamp should be after vesting period
        await setNextBlockTimestampFromCurrent(vestingPeriod + 5);
        let tx;
        await expect(
          (tx = await positionManager.connect(user).removeLiquidity({
            tokenId: nextTokenId,
            liquidity: liquidity,
            amount0Min: 0,
            amount1Min: 0,
            deadline: PRECISION,
          }))
        )
          .to.emit(positionManager, 'RemoveLiquidity')
          .to.not.emit(poolContract, 'BurnRTokens');

        let tx1 = await removeLiquidity(tokenA.address, tokenB.address, user, nextTokenId, liquidity);
        gasUsed = gasUsed.add((await tx1.wait()).gasUsed);

        // should update rToken owed and latest fee growth
        let userNewData = await positionManager.positions(nextTokenId);
        expect(userNewData.pos.rTokenOwed).to.be.gt(userData.pos.rTokenOwed);
        // feeGrowthInsideLast should have changed
        expect(userNewData.pos.feeGrowthInsideLast).to.not.be.eq(userData.pos.feeGrowthInsideLast);
      }
      if (showTxGasUsed) {
        logMessage(
          `Average gas use for remove liquidity (after vesting period) - has new fees: ${gasUsed
            .div(numRuns)
            .toString()}`
        );
      }
    });

    it('should have burnable tokens if liquidity removal happens during vesting period for fresh position', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address, 100000000);

      let gasUsed = ZERO;
      let numRuns = 3;
      let pool = await factory.getPool(token0, token1, swapFeeUnitsArray[0]);
      let poolContract = (await ethers.getContractAt('Pool', pool)) as Pool;
      let liquidity = (await positionManager.positions(nextTokenId)).pos.liquidity.div(numRuns * 2);

      for (let i = 0; i < numRuns; i++) {
        let userData = await positionManager.positions(nextTokenId);

        // made some swaps to get fees
        for (let j = 0; j < 3; j++) {
          let amount = BN.from(2500000 * (j + 1));
          await swapExactInput(tokenA.address, tokenB.address, swapFeeUnitsArray[0], amount);
          amount = BN.from(2500000 * (j + 1));
          await swapExactInput(tokenB.address, tokenA.address, swapFeeUnitsArray[0], amount);
        }

        // next block timestamp should be during vesting period
        await setNextBlockTimestampFromCurrent(vestingPeriod / 5);

        let tx;
        await expect(
          (tx = await positionManager.connect(user).removeLiquidity({
            tokenId: nextTokenId,
            liquidity: liquidity,
            amount0Min: ZERO,
            amount1Min: ZERO,
            deadline: PRECISION,
          }))
        )
          .to.emit(positionManager, 'RemoveLiquidity')
          .to.emit(poolContract, 'BurnRTokens');

        let tx1 = await removeLiquidity(tokenA.address, tokenB.address, user, nextTokenId, liquidity);
        gasUsed = gasUsed.add((await tx1.wait()).gasUsed);

        // should update rToken owed and latest fee growth
        let userNewData = await positionManager.positions(nextTokenId);
        expect(userNewData.pos.rTokenOwed).to.be.gt(userData.pos.rTokenOwed);
        // feeGrowthInsideLast should have changed
        expect(userNewData.pos.feeGrowthInsideLast).to.not.be.eq(userData.pos.feeGrowthInsideLast);
      }
      if (showTxGasUsed) {
        logMessage(
          `Average gas use for remove liquidity (during vesting period) - has new fees: ${gasUsed
            .div(numRuns)
            .toString()}`
        );
      }
    });

    it('should have burnt all tokens for snipping attack 1', async () => {
      const SnipAttack = (await ethers.getContractFactory('MockSnipAttack')) as MockSnipAttack__factory;
      let snipAttack = (await SnipAttack.deploy()) as MockSnipAttack;

      await tokenA.transfer(snipAttack.address, PRECISION.mul(2000000));
      await tokenB.transfer(snipAttack.address, PRECISION.mul(2000000));

      await weth.connect(user).approve(snipAttack.address, BIG_AMOUNT);
      await tokenA.connect(user).approve(snipAttack.address, BIG_AMOUNT);
      await tokenB.connect(user).approve(snipAttack.address, BIG_AMOUNT);

      await snipAttack.snip1(await factory.getPool(token0, token1, swapFeeUnitsArray[0]), positionManager.address, {
        token0: token0,
        token1: token1,
        fee: swapFeeUnitsArray[0],
        tickLower: -1000 * tickDistanceArray[0],
        tickUpper: 1000 * tickDistanceArray[0],
        ticksPrevious: ticksPrevious,
        amount0Desired: PRECISION,
        amount1Desired: PRECISION,
        amount0Min: 0,
        amount1Min: 0,
        recipient: snipAttack.address,
        deadline: PRECISION,
      });
    });

    it('should have burnt all tokens for snipping attack 2', async () => {
      const SnipAttack = (await ethers.getContractFactory('MockSnipAttack')) as MockSnipAttack__factory;
      let snipAttack = (await SnipAttack.deploy()) as MockSnipAttack;

      await tokenA.transfer(snipAttack.address, PRECISION.mul(2000000));
      await tokenB.transfer(snipAttack.address, PRECISION.mul(2000000));

      await weth.connect(user).approve(snipAttack.address, BIG_AMOUNT);
      await tokenA.connect(user).approve(snipAttack.address, BIG_AMOUNT);
      await tokenB.connect(user).approve(snipAttack.address, BIG_AMOUNT);

      await snipAttack.snip2(positionManager.address, await factory.getPool(token0, token1, swapFeeUnitsArray[0]), {
        token0: token0,
        token1: token1,
        fee: swapFeeUnitsArray[0],
        tickLower: -1000 * tickDistanceArray[0],
        tickUpper: 1000 * tickDistanceArray[0],
        ticksPrevious: ticksPrevious,
        amount0Desired: PRECISION,
        amount1Desired: PRECISION,
        amount0Min: 0,
        amount1Min: 0,
        recipient: snipAttack.address,
        deadline: PRECISION,
      });
    });
  });

  describe(`#sync fee growth`, async () => {
    let ticksFeesReader: TicksFeesReader;
    let antiSnipAttack: MockAntiSnipAttack;

    before('create and unlock pools', async () => {
      await revertToSnapshot(initialSnapshotId);
      initialSnapshotId = await snapshot();
      await createAndUnlockPools();
      snapshotId = await snapshot();
    });

    beforeEach('revert to snapshot', async () => {
      await revertToSnapshot(snapshotId);
      snapshotId = await snapshot();
      nextTokenId = await positionManager.nextTokenId();

      const TicksFeesReaderFactory = (await ethers.getContractFactory('TicksFeesReader')) as TicksFeesReader__factory;
      ticksFeesReader = await TicksFeesReaderFactory.deploy();

      const antiSnipAttackFactory = (await ethers.getContractFactory(
        'MockAntiSnipAttack'
      )) as MockAntiSnipAttack__factory;
      antiSnipAttack = await antiSnipAttackFactory.deploy();
    });

    it('revert sync fee growth author', async () => {
      await initLiquidity(user, tokenA.address, tokenB.address);
      await initLiquidity(other, tokenA.address, tokenB.address);

      let users = [user, other];
      let tokenIds = [nextTokenId, nextTokenId.add(1)];
      let numRuns = 2;

      for (let i = 0; i < numRuns; i++) {
        let sender = users[(i + 1) % 2];
        let tokenId = tokenIds[i % 2];

        // made some swaps to get fees
        for (let j = 0; j < 5; j++) {
          await swapExactInput(tokenA.address, tokenB.address, swapFeeUnitsArray[0], BN.from(100000 * (j + 1)));
          await swapExactInput(tokenB.address, tokenA.address, swapFeeUnitsArray[0], BN.from(150000 * (j + 1)));
        }

        await expect(positionManager.connect(sender).syncFeeGrowth(tokenId)).to.be.revertedWith('Not approved');
      }
    });

    it('sync fee growth -> burnRToken and check lock amount', async () => {
      let pool = await factory.getPool(tokenA.address, tokenB.address, swapFeeUnitsArray[0]);

      await initLiquidity(user, tokenA.address, tokenB.address);
      for (let j = 0; j < 5; j++) {
        await swapExactInput(tokenA.address, tokenB.address, swapFeeUnitsArray[0], BN.from(100000 * (j + 1)));
        await swapExactInput(tokenB.address, tokenA.address, swapFeeUnitsArray[0], BN.from(150000 * (j + 1)));
      }

      let rTokenOwned = await ticksFeesReader.getTotalRTokensOwedToPosition(
        positionManager.address,
        pool,
        nextTokenId
      );
      let antiSnipAttackData = await positionManager.antiSnipAttackData(nextTokenId);

      let deltaTime = (await getLatestBlockTime()) + 10 - antiSnipAttackData.lockTime;
      let feesClaimableSinceLastActionFeeUnits = Math.min(FEE_UNITS, (deltaTime * FEE_UNITS) / vestingPeriod);

      let dataLockShouldBe = await antiSnipAttack.calcFeeProportions(
        antiSnipAttackData.feesLocked,
        rTokenOwned.toNumber(),
        100000,
        feesClaimableSinceLastActionFeeUnits
      );

      await setNextBlockTimestampFromCurrent(10);
      await syncFeeGrowth(user, nextTokenId);

      await burnRTokens(tokenA.address, tokenB.address, user, nextTokenId);
      let dataLock = await positionManager.antiSnipAttackData(nextTokenId);

      expect(dataLock.feesLocked).to.be.eq(dataLockShouldBe.feesLockedNew);
      await setNextBlockTimestampFromCurrent(vestingPeriod + 5);
      await syncFeeGrowth(user, nextTokenId);
      let dataLock1 = await positionManager.antiSnipAttackData(nextTokenId);
      expect(dataLock1.feesLocked.toNumber()).to.be.eq(0);
    });

    it('sync fee growth -> burnRToken and check lock amount 2', async () => {
      let pool = await factory.getPool(tokenA.address, tokenB.address, swapFeeUnitsArray[0]);

      await initLiquidity(other, tokenA.address, tokenB.address);
      for (let j = 0; j < 5; j++) {
        await swapExactInput(tokenA.address, tokenB.address, swapFeeUnitsArray[0], BN.from(170000 * (j + 1)));
        await swapExactInput(tokenB.address, tokenA.address, swapFeeUnitsArray[0], BN.from(130000 * (j + 1)));
      }

      let rTokenOwned = await ticksFeesReader.getTotalRTokensOwedToPosition(
        positionManager.address,
        pool,
        nextTokenId
      );
      let antiSnipAttackData = await positionManager.antiSnipAttackData(nextTokenId);

      let deltaTime = (await getLatestBlockTime()) + 10 - antiSnipAttackData.lockTime;
      let feesClaimableSinceLastActionFeeUnits = Math.min(FEE_UNITS, (deltaTime * FEE_UNITS) / vestingPeriod);

      let dataLockShouldBe = await antiSnipAttack.calcFeeProportions(
        antiSnipAttackData.feesLocked,
        rTokenOwned.toNumber(),
        100000,
        feesClaimableSinceLastActionFeeUnits
      );

      await setNextBlockTimestampFromCurrent(10);

      await syncFeeGrowth(other, nextTokenId);
      await burnRTokens(tokenA.address, tokenB.address, other, nextTokenId);
      let dataLock = await positionManager.antiSnipAttackData(nextTokenId);
      expect(dataLock.feesLocked).to.be.eq(dataLockShouldBe.feesLockedNew);
      await setNextBlockTimestampFromCurrent(vestingPeriod + 5);
      await syncFeeGrowth(other, nextTokenId);
      let dataLock1 = await positionManager.antiSnipAttackData(nextTokenId);
      expect(dataLock1.feesLocked.toNumber()).to.be.eq(0);
    });
  });
});

function logMessage(message: string) {
  console.log(`         ${message}`);
}
