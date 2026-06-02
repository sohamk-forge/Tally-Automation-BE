import pool from "../db/index.js";
import { sendToTally } from "../services/tallyClient.js";
import { getStockItemCreateXML } from "../services/pushXmlBuilder.js";

let isProcessing = false;

const processPushStockItemJobs = async () => {
  if (isProcessing) {
    console.log("⚠️ Previous worker still running, skipping this cycle");
    return;
  }

  isProcessing = true;

  try {
    const result = await pool.query(`
      SELECT *
      FROM app_test.push_stock_item
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT 5
    `);

    if (!result.rows.length) {
      console.log("📭 No pending stock items to process");
      return;
    }

    console.log(`📋 Found ${result.rows.length} pending items to process`);

    for (const row of result.rows) {
      let tallyResponse = null;

      try {
        console.log("\n" + "=".repeat(60));
        console.log(`🔄 PROCESSING ITEM ID: ${row.id}`);
        console.log(`📦 ITEM NAME: ${row.item_name}`);
        console.log("=".repeat(60));
        
        console.log("📊 GST Configuration:");
        console.log(`   - GST Applicable: ${row.gst_applicable || 'Not Applicable'}`);
        console.log(`   - Parent Group: ${row.parent_group || 'Primary'}`);
        console.log(`   - HSN Code: ${row.hsn_code || 'Not provided'}`);
        console.log(`   - CGST: ${row.cgst_rate || 0}%`);
        console.log(`   - SGST: ${row.sgst_rate || 0}%`);
        console.log(`   - IGST: ${row.igst_rate || 0}%`);

        const xml = getStockItemCreateXML({
          company: row.company_name,
          itemName: row.item_name,
          alias: row.alias_name,
          unit: row.unit_name,
          description: row.description,
          hsnCode: row.hsn_code,
          cgst: row.cgst_rate,
          sgst: row.sgst_rate,
          igst: row.igst_rate,
          gstApplicable: row.gst_applicable,
          parentGroup: row.parent_group
        });

        console.log("\n🚀 Sending to Tally...");
        tallyResponse = await sendToTally(xml);
        
        console.log("\n📥 RAW XML RESPONSE:");
        console.log(tallyResponse);

        const createdMatch = tallyResponse.match(/<CREATED>(\d+)<\/CREATED>/);
        const created = createdMatch ? Number(createdMatch[1]) : 0;
        
        const alteredMatch = tallyResponse.match(/<ALTERED>(\d+)<\/ALTERED>/);
        const altered = alteredMatch ? Number(alteredMatch[1]) : 0;
        
        const lineErrorMatch = tallyResponse.match(/<LINEERROR>(.*?)<\/LINEERROR>/);
        const lineError = lineErrorMatch ? lineErrorMatch[1] : null;

        console.log(`\n📊 SUMMARY - Created: ${created}, Altered: ${altered}`);
        if (lineError) console.log(`   Line Error: ${lineError}`);

        const isSuccess = created === 1 || altered === 1;
        
        if (!isSuccess) {
          console.log(`\n❌ FAILED: ${row.item_name}`);
          
          await pool.query(`
            UPDATE app_test.push_stock_item
            SET 
              status = 'failed',
              tally_response = $1,
              error_count = COALESCE(error_count, 0) + 1,
              last_error = $2,
              updated_at = NOW()
            WHERE id = $3
          `, [tallyResponse, lineError || 'No line error provided', row.id]);
          
          continue;
        }

        console.log(`\n✅ SUCCESS: ${row.item_name}`);
        
        await pool.query(`
          UPDATE app_test.push_stock_item
          SET 
            status = 'success',
            tally_response = $1,
            error_count = 0,
            last_error = NULL,
            updated_at = NOW()
          WHERE id = $2
        `, [tallyResponse, row.id]);

      } catch (err) {
        console.log(`\n💥 ERROR: ${row.item_name} - ${err.message}`);
        
        await pool.query(`
          UPDATE app_test.push_stock_item
          SET 
            status = 'pending',
            error_count = COALESCE(error_count, 0) + 1,
            last_error = $1,
            updated_at = NOW()
          WHERE id = $2
        `, [err.message, row.id]);
      }
    }

  } catch (err) {
    console.error("\n💥 WORKER CRITICAL ERROR:", err.message);
  } finally {
    isProcessing = false;
  }
};

setInterval(processPushStockItemJobs, 30000);
console.log("✅ Push Stock Item Worker Started");

processPushStockItemJobs();