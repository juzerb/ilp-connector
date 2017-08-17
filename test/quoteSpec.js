'use strict'

const mockPlugin = require('./mocks/mockPlugin')
const mock = require('mock-require')
mock('ilp-plugin-mock', mockPlugin)

const LiquidityCurve = require('ilp-routing').LiquidityCurve
const co = require('co')
const sinon = require('sinon')
const nock = require('nock')
const IlpPacket = require('ilp-packet')
nock.enableNetConnect(['localhost'])
const ratesResponse = require('./data/fxRates.json')
const appHelper = require('./helpers/app')
const logger = require('../src/common/log')
const logHelper = require('./helpers/log')
const chai = require('chai')
const assert = chai.assert
const expect = chai.expect
chai.use(require('chai-as-promised'))
const _ = require('lodash')
const IlpError = require('../src/errors/ilp-error')
const ExternalError = require('../src/errors/external-error')
const InvalidAmountSpecifiedError = require('../src/errors/invalid-amount-specified-error')
const AssetsNotTradedError = require('../src/errors/assets-not-traded-error')
const NoRouteFoundError = require('../src/errors/no-route-found-error')
const UnacceptableAmountError = require('../src/errors/unacceptable-amount-error')
const UnacceptableExpiryError = require('../src/errors/unacceptable-expiry-error')
const LedgerNotConnectedError = require('../src/errors/ledger-not-connected-error')
const START_DATE = 1434412800000 // June 16, 2015 00:00:00 GMT

describe('Quotes', function () {
  logHelper(logger)

  beforeEach(function * () {
    appHelper.create(this)
    this.clock = sinon.useFakeTimers(START_DATE)

    const testLedgers = ['cad-ledger.', 'usd-ledger.', 'eur-ledger.', 'cny-ledger.']
    _.map(testLedgers, (ledgerUri) => {
      this.ledgers.getPlugin(ledgerUri).getBalance =
        function * () { return '150000' }
    })

    yield this.backend.connect(ratesResponse)
    yield this.ledgers.connect()
    yield this.routeBroadcaster.reloadLocalRoutes()
  })

  afterEach(function () {
    this.clock.restore()
    nock.cleanAll()
  })

  it('should return a InvalidAmountSpecifiedError if sourceAmount is zero', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '0',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob'
    }))

    yield assert.isRejected(quotePromise, InvalidAmountSpecifiedError, 'sourceAmount must be positive')
  })

  it('should return a InvalidAmountSpecifiedError if destinationAmount is zero', function * () {
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      destinationAmount: '0',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob'
    }))

    yield assert.isRejected(quotePromise, InvalidAmountSpecifiedError, 'destinationAmount must be positive')
  })

  it('should return NoRouteFoundError when the destination amount is unachievable', function * () {
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      destinationAmount: '100000000000000000000000000000',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 1.001
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: eur-ledger.alice to: usd-ledger.bob')
  })

  it('should return NoRouteFoundError when the source ledger is not supported', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'fake-ledger.foley',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 1.001
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: fake-ledger.foley to: usd-ledger.bob')
  })

  // This test doesn't currently pass - I think it's because the connector is
  // smart enough to construct a route of A -> B -> C through itself, even if
  // A -> C isn't a pair, but A -> B and B -> C are.
  //
  // This might actually be the desired behavior... if we're willing to trade
  // A for B and B for C, we're implicitly willing to trade A for C.
  it.skip('should return AssetsNotTradedError when the pair is not supported', function * () {
    const quotePromise = this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'cad-ledger.bob',
      destinationAccount: 'cny-ledger.bob',
      destinationHoldDuration: 1.001
    })

    yield assert.isRejected(quotePromise, AssetsNotTradedError, 'This connector does not support the given asset pair')
  })

  // Skipping because it needs to use an alternate curve to get a 0.
  it.skip('should return a UnacceptableAmountError if the quoted destinationAmount is 0', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '0.00001',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob'
    }))

    yield assert.isRejected(quotePromise, UnacceptableAmountError, 'Quoted destination is lower than minimum amount allowed')
  })

  it('should return NoRouteFoundError when the destination ledger is not supported', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'example.fake.blah',
      destinationHoldDuration: 1.001
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: eur-ledger.alice to: example.fake.blah')
  })

  it('should return a UnacceptableExpiryError if the destinationHoldDuration is too long', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 10001
    }))

    yield assert.isRejected(quotePromise, UnacceptableExpiryError, /Destination expiry duration is too long/)
  })

  it('should return an Error for insufficient liquidity', function * () {
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      destinationAmount: '150001',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 10
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: eur-ledger.alice to: usd-ledger.bob')
  })

  it('should not return an Error when unable to get balance from ledger', function * () {
    nock.cleanAll()
    this.ledgers.getPlugin('usd-ledger.')
      .getBalance = function * () { throw new ExternalError() }

    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '1500001',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 10
    }))

    yield assert.isFulfilled(quotePromise)
  })

  it('should return quotes for fixed source amounts', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '100000',
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5000
    })

    expect(quote).to.deep.equal({
      sourceHoldDuration: 6000,
      destinationAmount: '105708' // EUR/USD Rate of 1.0592 - .2% spread
    })
  })

  // TODO: make sure we're calculating the rates correctly and in our favor
  it('should return quotes for fixed destination amounts', function * () {
    const quote = yield this.routeBuilder.quoteByDestination({
      sourceAccount: 'eur-ledger.alice',
      destinationAmount: '100000',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5000
    })
    expect(quote).to.deep.equal({
      sourceAmount: '94601', // (1/ EUR/USD Rate of 1.0592) + .2% spread + round up to overestimate
      sourceHoldDuration: 6000
    })
  })

  it('should return local liquidity curve quotes', function * () {
    const quote = yield this.routeBuilder.quoteLiquidity({
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5000
    })
    expect(quote).to.deep.equal({
      liquidityCurve: new LiquidityCurve([ [ 1, 0 ], [ 141901, 150000 ] ]).toBuffer(),
      appliesToPrefix: 'usd-ledger.',
      sourceHoldDuration: 6000,
      expiresAt: new Date(START_DATE + 45000)
    })
  })

  it('should return remote liquidity curve quotes', function * () {
    const curve = new LiquidityCurve([ [0, 0], [10000, 20000] ]).toBuffer()
    this.config.routeBroadcastEnabled = false
    yield this.messageRouter.receiveRoutes({
      new_routes: [{
        source_ledger: 'eur-ledger.',
        destination_ledger: 'random-ledger.',
        min_message_window: 1,
        source_account: 'eur-ledger.mary',
        points: curve.toString('base64')
      }],
      hold_down_time: 1234,
      unreachable_through_me: []
    }, 'eur-ledger.mary')
    this.config.routeBroadcastEnabled = true

    const quote = yield this.routeBuilder.quoteLiquidity({
      sourceAccount: 'usd-ledger.alice',
      destinationAccount: 'random-ledger.carl',
      destinationHoldDuration: 5000
    })
    expect(quote).to.deep.equal({
      liquidityCurve: new LiquidityCurve([ [1, 0], [10614, 20000] ]).toBuffer(),
      appliesToPrefix: 'random-ledger.',
      sourceHoldDuration: 7000,
      expiresAt: new Date(START_DATE + 45000)
    })
  })

  it('should return liquidity curve quotes with the correct appliesToPrefix', function * () {
    const curve = new LiquidityCurve([ [1, 0], [1001, 1000] ]).toBuffer().toString('base64')
    ;['', 'a.', 'a.b.'].forEach((targetPrefix) => {
      this.routingTables.addRoute({
        source_ledger: 'eur-ledger.',
        source_account: 'eur-ledger.mark',
        destination_ledger: 'usd-ledger.',
        target_prefix: targetPrefix,
        min_message_window: 1,
        points: curve
      })
    })
    expect((yield this.routeBuilder.quoteLiquidity({
      sourceAccount: 'cad-ledger.alice',
      destinationAccount: 'random-ledger.carl',
      destinationHoldDuration: 5000
    })).appliesToPrefix).to.equal('random-ledger.') // Can't be "", since that would match "eur-ledger.".
    expect((yield this.routeBuilder.quoteLiquidity({
      sourceAccount: 'cad-ledger.alice',
      destinationAccount: 'a.b.carl',
      destinationHoldDuration: 5000
    })).appliesToPrefix).to.equal('a.b.')
    expect((yield this.routeBuilder.quoteLiquidity({
      sourceAccount: 'cad-ledger.alice',
      destinationAccount: 'a.c.b.carl',
      destinationHoldDuration: 5000
    })).appliesToPrefix).to.equal('a.c.')
  })

  it('should apply the spread correctly for payments where the source asset is the counter currency in the fx rates', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '100000',
      sourceAccount: 'usd-ledger.bob',
      destinationAccount: 'eur-ledger.alice',
      destinationHoldDuration: 5000
    })
    expect(quote).to.deep.equal({
      destinationAmount: '94222', // 1 / (EUR/USD Rate of 1.0592 + .2% spread)
      sourceHoldDuration: 6000
    })
  })

  it('should determine the correct rate and spread when neither the source nor destination asset is the base currency in the rates', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '100000',
      sourceAccount: 'usd-ledger.bob',
      destinationAccount: 'cad-ledger.carl',
      destinationHoldDuration: 5000
    })
    expect(quote).to.deep.equal({
      destinationAmount: '127981', // USD/CAD Rate (1.3583 / 1.0592) - .2% spread
      sourceHoldDuration: 6000
    })
  })

  it('should determine the correct rate and spread when neither the source nor destination asset is the base currency in the rates and the rate must be flipped', function * () {
    const quote = yield this.routeBuilder.quoteBySource({
      sourceAmount: '100000',
      sourceAccount: 'cad-ledger.carl',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5000
    })
    expect(quote).to.deep.equal({
      destinationAmount: '77823', // 1/(USD/CAD Rate (1.3583 / 1.0592) + .2% spread)
      sourceHoldDuration: 6000
    })
  })

  describe('if route has no curve, quotes a multi-hop route', function () {
    beforeEach(function * () {
      this.config.routeBroadcastEnabled = false
      yield this.messageRouter.receiveRoutes({
        new_routes: [{
          source_ledger: 'eur-ledger.',
          destination_ledger: 'random-ledger.',
          min_message_window: 1,
          source_account: 'eur-ledger.mary'
        }],
        hold_down_time: 1234,
        unreachable_through_me: []
      }, 'eur-ledger.mary')
      this.config.routeBroadcastEnabled = true
    })

    it('returns a quote when appliesToPrefix is more general than targetPrefix', function * () {
      this.ledgers.getPlugin('eur-ledger.').sendRequest = (request) => {
        assert.deepEqual(IlpPacket.deserializeIlqpLiquidityRequest(Buffer.from(request.ilp, 'base64')), {
          destinationAccount: 'random-ledger.bob',
          destinationHoldDuration: 5000
        })
        return Promise.resolve({
          ilp: IlpPacket.serializeIlqpLiquidityResponse({
            liquidityCurve: new LiquidityCurve([ [0, 0], [1000, 2000] ]).toBuffer(),
            appliesToPrefix: 'random',
            sourceHoldDuration: 6000,
            expiresAt: new Date(START_DATE + 10000)
          })
        })
      }

      const quote = yield this.routeBuilder.quoteBySource({
        sourceAmount: '100',
        sourceAccount: 'usd-ledger.alice',
        destinationAccount: 'random-ledger.bob',
        destinationHoldDuration: 5000
      })
      expect(quote).to.deep.equal({
        destinationAmount: '188', // (100 / 1.0592) * 2
        sourceHoldDuration: 7000
      })
    })

    it('returns a quote when appliesToPrefix is more specific than targetPrefix', function * () {
      this.ledgers.getPlugin('eur-ledger.').sendRequest = (request) => {
        assert.deepEqual(IlpPacket.deserializeIlqpLiquidityRequest(Buffer.from(request.ilp, 'base64')), {
          destinationAccount: 'random-ledger.bob',
          destinationHoldDuration: 5000
        })
        return Promise.resolve({
          ilp: IlpPacket.serializeIlqpLiquidityResponse({
            liquidityCurve: new LiquidityCurve([ [0, 0], [1000, 2000] ]).toBuffer(),
            appliesToPrefix: 'random-ledger.b',
            sourceHoldDuration: 6000,
            expiresAt: new Date(START_DATE + 10000)
          })
        })
      }

      const quote = yield this.routeBuilder.quoteBySource({
        sourceAmount: '100',
        sourceAccount: 'usd-ledger.alice',
        destinationAccount: 'random-ledger.bob',
        destinationHoldDuration: 5000
      })
      expect(quote).to.deep.equal({
        destinationAmount: '188', // (100 / 1.0592) * 2
        sourceHoldDuration: 7000
      })
    })

    it('relays an error packet', function * () {
      const errorPacket = {
        responseType: 8,
        code: 'F01',
        name: 'Invalid Packet',
        triggeredBy: 'example.us.ledger3.bob',
        forwardedBy: [ 'foo' ],
        triggeredAt: new Date(),
        data: JSON.stringify({ foo: 'bar' })
      }
      this.ledgers.getPlugin('eur-ledger.').sendRequest = (request) => {
        return Promise.resolve({ ilp: IlpPacket.serializeIlpError(errorPacket) })
      }

      try {
        yield this.routeBuilder.quoteBySource({
          sourceAmount: '100',
          sourceAccount: 'usd-ledger.alice',
          destinationAccount: 'random-ledger.bob',
          destinationHoldDuration: 5000
        })
      } catch (err) {
        expect(err).to.be.instanceof(IlpError)
        expect(err.packet).to.deep.equal(errorPacket)
        return
      }
      assert(false)
    })
  })

  it('fails on a same-ledger quote', function * () {
    const quotePromise = co(this.routeBuilder.quoteBySource({
      sourceAmount: '100',
      sourceAccount: 'usd-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationHoldDuration: 5
    }))

    yield assert.isRejected(quotePromise, NoRouteFoundError, 'No route found from: usd-ledger.alice to: usd-ledger.bob')
  })

  it('fails when the source ledger connection is closed', function * () {
    this.ledgers.getPlugin('eur-ledger.').connected = false
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationAmount: '100',
      destinationHoldDuration: 5
    }))

    yield assert.isRejected(quotePromise, LedgerNotConnectedError, 'No connection to ledger "eur-ledger."')
  })

  it('fails when the destination ledger connection is closed', function * () {
    this.ledgers.getPlugin('usd-ledger.').connected = false
    const quotePromise = co(this.routeBuilder.quoteByDestination({
      sourceAccount: 'eur-ledger.alice',
      destinationAccount: 'usd-ledger.bob',
      destinationAmount: '100',
      destinationHoldDuration: 5
    }))

    yield assert.isRejected(quotePromise, LedgerNotConnectedError, 'No connection to ledger "usd-ledger."')
  })
})
