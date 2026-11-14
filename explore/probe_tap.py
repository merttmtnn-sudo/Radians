import pyvo, numpy as np
tap = pyvo.dal.TAPService("https://irsa.ipac.caltech.edu/TAP")
q = """SELECT obs_collection, COUNT(*) AS n, MIN(t_min) AS t0, MAX(t_min) AS t1
FROM ivoa.obscore
WHERE CONTAINS(POINT('ICRS',133.795129,-7.245147), s_region)=1
GROUP BY obs_collection"""
print(tap.search(q).to_table())
