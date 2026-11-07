import { expect } from 'chai'
import { priceYes, prices } from '../maker/pricing'

describe('maker pricing', () => {
    it('prices covenant YES as target <= strike and equality wins', () => {
        expect(priceYes([100, 100, 100], 100, 100, 1)).eq(1)
        expect(priceYes([100, 100, 100], 101, 100, 1)).eq(0)
        expect(priceYes([100, 90, 81], 81, 81, 1)).eq(1)
        expect(priceYes([100, 110, 121], 121, 121, 1)).eq(0)
    })
    it('bounds probabilities and makes an eight-point bid/ask spread', () => {
        for (const spot of [1, 50, 100, 200, 1e20]) {
            const p = priceYes([100, 95, 110, 98], spot, 100, 0.5)
            expect(p).within(0, 1)
            const q = prices(p)
            expect(q.yesAsk).at.least(p)
            expect(q.noAsk).at.least(1 - p)
            if (p >= 0.04 && p <= 0.96)
                expect(q.yesAsk + q.noAsk).closeTo(1.08, 1e-12)
        }
        expect(() => priceYes([0, 10], 10, 10, 1)).throws()
    })
})
